#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Deploys SE Assist backend infrastructure and image to Azure (dev environment).

.DESCRIPTION
    Three-phase deployment:
      Phase 1: Create resource group and deploy supporting infra
               (ACR, AI Services + model deployment, PostgreSQL, Container Apps env,
               Log Analytics, App Insights, Key Vault, Storage). The Container App
               itself is NOT created in this phase.
      Phase 2: Build the backend image using `az acr build` in the new ACR.
      Phase 3: Re-deploy the Bicep with deployContainerApp=true and the built image
               so the Container App is created with a working image from the start.
      Phase 4: Smoke test /health.

.PARAMETER ResourceGroupName
    Defaults to rg-seassist-dev.

.PARAMETER Location
    Defaults to swedencentral.

.PARAMETER BaseName
    Defaults to seassistdev.
#>
[CmdletBinding()]
param(
    [string] $ResourceGroupName = 'rg-seassist-dev',
    [string] $Location = 'swedencentral',
    [string] $BaseName = 'seassistdev',
    [string] $SubscriptionId = '',
    [securestring] $PostgresAdminPassword,
    [switch] $SkipImageBuild,
    [switch] $SkipInfraDeploy
)

$ErrorActionPreference = 'Stop'

function Write-Section($message) {
    Write-Host ""
    Write-Host "=== $message ===" -ForegroundColor Cyan
}

function Invoke-Az([string[]] $AzArgs, [switch] $RawOutput) {
    $tempErr = [System.IO.Path]::GetTempFileName()
    try {
        $output = & az @AzArgs 2>$tempErr
        $exitCode = $LASTEXITCODE
        $errOutput = Get-Content -Raw -ErrorAction SilentlyContinue $tempErr
        if ($errOutput -and ($errOutput.Trim().Length -gt 0)) {
            $errOutput.Trim().Split("`n") | ForEach-Object {
                Write-Host "[az stderr] $_" -ForegroundColor DarkYellow
            }
        }
        if ($exitCode -ne 0) {
            throw "az $($AzArgs -join ' ') failed with exit code $exitCode"
        }
        if ($RawOutput) { return $output }
        if ($output -is [array]) { return ($output -join "`n") }
        return $output
    } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $tempErr
    }
}

if ($SubscriptionId) {
    Write-Section "Setting subscription"
    Invoke-Az @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
}

$accountJson = Invoke-Az @('account', 'show', '-o', 'json')
$account = $accountJson | ConvertFrom-Json
Write-Host "Subscription : $($account.name) ($($account.id))" -ForegroundColor Green
Write-Host "Tenant       : $($account.tenantId)" -ForegroundColor Green
Write-Host "Signed in as : $($account.user.name)" -ForegroundColor Green

Write-Section "Resolving signed-in principal"
$signedInJson = Invoke-Az @('ad', 'signed-in-user', 'show', '-o', 'json')
$signedIn = $signedInJson | ConvertFrom-Json
$deployerPrincipalId = $signedIn.id
$postgresAdminObjectId = $signedIn.id
$postgresAdminPrincipalName = $signedIn.userPrincipalName
Write-Host "Principal ID : $deployerPrincipalId" -ForegroundColor Green
Write-Host "Principal UPN: $postgresAdminPrincipalName" -ForegroundColor Green

Write-Section "Resolving PostgreSQL admin password"
if (-not $PostgresAdminPassword) {
    $bytes = New-Object 'System.Byte[]' 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $generated = ([Convert]::ToBase64String($bytes) -replace '[+/=]', '') + 'Aa1!'
    $PostgresAdminPassword = ConvertTo-SecureString $generated -AsPlainText -Force
    Write-Host "Generated a strong password (store it securely; it is not printed)." -ForegroundColor Yellow
} else {
    Write-Host "Using provided -PostgresAdminPassword." -ForegroundColor Green
}
$postgresAdminPasswordPlain = [System.Net.NetworkCredential]::new('', $PostgresAdminPassword).Password

Write-Section "Ensuring resource group $ResourceGroupName in $Location"
$rgExistsJson = Invoke-Az @('group', 'exists', '--name', $ResourceGroupName, '-o', 'tsv')
if ($rgExistsJson.Trim() -eq 'true') {
    Write-Host "Resource group already exists" -ForegroundColor Yellow
} else {
    Invoke-Az @(
        'group', 'create',
        '--name', $ResourceGroupName,
        '--location', $Location,
        '--tags', 'app=se-assist', 'env=dev', 'owner=se-assist-cli'
    ) | Out-Null
    Write-Host "Resource group created" -ForegroundColor Green
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$bicepPath = Join-Path $repoRoot 'infra\main.bicep'
$backendDir = Join-Path $repoRoot 'backend'

function Invoke-Deployment([string] $Phase, [hashtable] $Parameters) {
    $deploymentName = "seassist-dev-${Phase}-$(Get-Date -Format 'yyyyMMddHHmmss')"
    $parameterArgs = @()
    foreach ($key in $Parameters.Keys) {
        $parameterArgs += "$key=$($Parameters[$key])"
    }
    $args = @(
        'deployment', 'group', 'create',
        '--resource-group', $ResourceGroupName,
        '--name', $deploymentName,
        '--template-file', $bicepPath,
        '--parameters'
    ) + $parameterArgs + @('-o', 'json')
    $json = Invoke-Az $args
    $deployment = $json | ConvertFrom-Json
    return $deployment
}

if (-not $SkipInfraDeploy) {
    Write-Section "Phase 1: deploying supporting infra (no Container App)"
    $phase1 = Invoke-Deployment 'infra' @{
        name = $BaseName
        location = $Location
        postgresAdminObjectId = $postgresAdminObjectId
        postgresAdminPrincipalName = $postgresAdminPrincipalName
        postgresAdminPassword = $postgresAdminPasswordPlain
        deployerPrincipalId = $deployerPrincipalId
        deployContainerApp = 'false'
    }
    $outputs = $phase1.properties.outputs
    Write-Host "Registry     : $($outputs.containerRegistryLoginServer.value)" -ForegroundColor Green
    Write-Host "Foundry      : $($outputs.foundryEndpoint.value)" -ForegroundColor Green
    Write-Host "Postgres host: $($outputs.postgresHost.value)" -ForegroundColor Green
} else {
    Write-Section "Reading existing deployment outputs"
    $latest = (Invoke-Az @(
        'deployment', 'group', 'list',
        '--resource-group', $ResourceGroupName,
        '--query', "sort_by([?properties.provisioningState=='Succeeded' && starts_with(name, 'seassist-dev-')], &properties.timestamp)[-1].name",
        '-o', 'tsv'
    )).Trim()
    if (-not $latest) {
        throw 'No succeeded deployment found; cannot use --SkipInfraDeploy on a fresh resource group.'
    }
    $phase1 = Invoke-Az @('deployment', 'group', 'show', '--resource-group', $ResourceGroupName, '--name', $latest, '-o', 'json') | ConvertFrom-Json
    $outputs = $phase1.properties.outputs
}

$registry = $outputs.containerRegistryName.value
$loginServer = $outputs.containerRegistryLoginServer.value

$imageTag = Get-Date -Format 'yyyyMMddHHmmss'
$imageName = "se-assist-backend:$imageTag"
$fullImage = "$loginServer/$imageName"

if (-not $SkipImageBuild) {
    Write-Section "Phase 2: building backend image via ACR build"
    Push-Location $repoRoot
    try {
        Invoke-Az @(
            'acr', 'build',
            '--registry', $registry,
            '--image', $imageName,
            '--file', 'backend/Dockerfile',
            '.'
        ) | Out-Null
    } finally {
        Pop-Location
    }
    Write-Host "Image pushed: $fullImage" -ForegroundColor Green
} else {
    Write-Section "Looking up latest image in ACR"
    $tagJson = Invoke-Az @('acr', 'repository', 'show-tags', '--name', $registry, '--repository', 'se-assist-backend', '--orderby', 'time_desc', '--top', '1', '-o', 'tsv')
    $existingTag = $tagJson.Trim()
    if (-not $existingTag) {
        throw "No images found in $registry/se-assist-backend; rerun without --SkipImageBuild."
    }
    $fullImage = "$loginServer/se-assist-backend:$existingTag"
    Write-Host "Reusing image: $fullImage" -ForegroundColor Yellow
}

Write-Section "Phase 3: deploying Container App with built image"
$phase3 = Invoke-Deployment 'app' @{
    name = $BaseName
    location = $Location
    backendImage = $fullImage
    postgresAdminObjectId = $postgresAdminObjectId
    postgresAdminPrincipalName = $postgresAdminPrincipalName
    postgresAdminPassword = $postgresAdminPasswordPlain
    deployerPrincipalId = $deployerPrincipalId
    deployContainerApp = 'true'
}
$outputs = $phase3.properties.outputs
$containerAppName = $outputs.containerAppName.value
$backendUrl = $outputs.backendUrl.value
Write-Host "Container App: $containerAppName" -ForegroundColor Green
Write-Host "Backend URL  : $backendUrl" -ForegroundColor Green

Write-Section "Phase 4: smoke test /health"
$healthUrl = "$backendUrl/health"
Write-Host "Probing $healthUrl" -ForegroundColor Gray
$maxAttempts = 18
$smokeOk = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -Method GET -TimeoutSec 20 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Host "Health check OK on attempt $attempt" -ForegroundColor Green
            Write-Host ($response.Content) -ForegroundColor DarkGray
            $smokeOk = $true
            break
        }
    } catch {
        Write-Host "Attempt $attempt failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Start-Sleep -Seconds 15
    }
}
if (-not $smokeOk) {
    Write-Host "Health check did not succeed after $maxAttempts attempts; investigate Container App logs." -ForegroundColor Red
}

Write-Section "Deployment summary"
Write-Host "Resource group : $ResourceGroupName"
Write-Host "Location       : $Location"
Write-Host "Backend URL    : $backendUrl"
Write-Host "Container App  : $containerAppName"
Write-Host "Image          : $fullImage"
Write-Host "Registry       : $loginServer"
Write-Host "Foundry        : $($outputs.foundryEndpoint.value)"
Write-Host "Foundry deploy : $($outputs.foundryDeploymentName.value)"
Write-Host "Postgres host  : $($outputs.postgresHost.value)"
Write-Host "Key Vault URI  : $($outputs.keyVaultUri.value)"
Write-Host "App Insights   : configured"
Write-Host "Smoke test OK  : $smokeOk"
