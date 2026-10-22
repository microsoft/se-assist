targetScope = 'resourceGroup'

@description('Base name used for Azure resources.')
@maxLength(15)
param name string = 'seassistdev'

@description('Azure region for all resources.')
param location string = 'swedencentral'

@description('Container image for the SE Assist backend API. Use a placeholder for the first deployment.')
param backendImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Object ID for the Entra admin assigned to PostgreSQL.')
param postgresAdminObjectId string

@description('User principal name for the Entra PostgreSQL admin.')
param postgresAdminPrincipalName string

@description('Administrator login name for PostgreSQL password authentication.')
param postgresAdminLogin string = 'seassistadmin'

@description('Administrator password for PostgreSQL password authentication. Provide a strong value at deploy time.')
@secure()
param postgresAdminPassword string

@description('Name of the application database created on the PostgreSQL server.')
param postgresDatabaseName string = 'se_assist'

@description('Name of the PostgreSQL flexible server. Defaults to the existing app server so IaC and local config target the same instance.')
param postgresServerName string = 'seassistdev-pg-app'

@description('Object ID for the deployment principal that should receive ACR Push role.')
param deployerPrincipalId string = ''

@description('Model name for the Foundry chat deployment.')
param foundryModelName string = 'gpt-4.1-mini'

@description('Model version for the Foundry chat deployment.')
param foundryModelVersion string = '2025-04-14'

@description('Deployment SKU capacity for the Foundry chat deployment, in thousands of TPM.')
param foundryModelCapacity int = 50

@description('When false, skips the Container App and its role assignments. Use false for the initial infra deployment when no image exists yet.')
param deployContainerApp bool = true

var suffix = uniqueString(resourceGroup().id, name)
var containerAppName = '${name}-api-${suffix}'
var environmentName = '${name}-env-${suffix}'
var postgresName = postgresServerName
var keyVaultName = take('${name}kv${suffix}', 24)
var storageName = take(toLower('${name}st${suffix}'), 24)
var appInsightsName = '${name}-appi-${suffix}'
var logAnalyticsName = '${name}-logs-${suffix}'
var containerRegistryName = take(toLower('${name}acr${suffix}'), 50)
var foundryAccountName = '${name}-ai-${suffix}'
var foundryDeploymentName = 'meeting-prep-${replace(foundryModelName, '.', '-')}'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: foundryAccountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: foundryAccountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource foundryDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: foundryDeploymentName
  sku: {
    name: 'Standard'
    capacity: foundryModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: foundryModelName
      version: foundryModelVersion
    }
    versionUpgradeOption: 'OnceCurrentVersionExpired'
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: {
      storageSizeGB: 32
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: tenant().tenantId
    }
    dataEncryption: {
      type: 'SystemManaged'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
  }
}

resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'pgcrypto'
    source: 'user-override'
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: postgresDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    postgresExtensions
  ]
}

resource postgresAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgres
  name: postgresAdminObjectId
  properties: {
    principalName: postgresAdminPrincipalName
    principalType: 'User'
    tenantId: tenant().tenantId
  }
  dependsOn: [
    postgresDatabase
  ]
}

resource postgresAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [
    postgresAdmin
  ]
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'

var pullIdentityName = '${name}-pull-${suffix}'

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: pullIdentityName
  location: location
}

resource acrPullForPullIdentity 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: containerRegistry
  name: guid(containerRegistry.id, pullIdentity.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource backend 'Microsoft.App/containerApps@2024-03-01' = if (deployContainerApp) {
  name: containerAppName
  location: location
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  dependsOn: [
    acrPullForPullIdentity
  ]
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 7071
        transport: 'auto'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'database-url'
          value: 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${postgresDatabaseName}?sslmode=require'
        }
      ]
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: backendImage
          env: [
            {
              name: 'PORT'
              value: '7071'
            }
            {
              name: 'AUTH_MODE'
              value: 'fake'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'FOUNDRY_ENDPOINT'
              value: foundry.properties.endpoint
            }
            {
              name: 'FOUNDRY_DEPLOYMENT'
              value: foundryDeployment.name
            }
            {
              name: 'FOUNDRY_API_VERSION'
              value: '2024-10-21'
            }
            {
              name: 'RUN_MIGRATIONS_ON_STARTUP'
              value: '0'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

resource foundryUserForApp 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployContainerApp) {
  scope: foundry
  name: guid(foundry.id, containerAppName, cognitiveServicesUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUserRoleId)
    principalId: backend!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPushForDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  scope: containerRegistry
  name: guid(containerRegistry.id, deployerPrincipalId, acrPushRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPushRoleId)
    principalId: deployerPrincipalId
    principalType: 'User'
  }
}

output backendUrl string = deployContainerApp ? 'https://${backend!.properties.configuration.ingress.fqdn}' : ''
output backendFqdn string = deployContainerApp ? backend!.properties.configuration.ingress.fqdn : ''
output containerAppName string = containerAppName
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output postgresName string = postgres.name
output postgresDatabaseName string = postgresDatabaseName
output keyVaultUri string = keyVault.properties.vaultUri
output storageAccountName string = storage.name
output containerRegistryName string = containerRegistry.name
output containerRegistryLoginServer string = containerRegistry.properties.loginServer
output foundryEndpoint string = foundry.properties.endpoint
output foundryAccountName string = foundry.name
output foundryDeploymentName string = foundryDeployment.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output deployContainerApp bool = deployContainerApp
