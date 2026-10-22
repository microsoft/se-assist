/**
 * Canonical Microsoft product catalog for SE Assist.
 *
 * Each product carries one or more capability labels so a solution engineer can
 * filter the catalog by the lens that matters for a given conversation:
 *   M365     — Microsoft 365 productivity & collaboration
 *   AI       — AI, Copilot, and machine-learning products
 *   Azure    — Azure-branded cloud platform services
 *   Cloud    — cloud-hosted (SaaS/PaaS) offerings
 *   On-Prem  — on-premises / customer-hosted server products
 *   Data     — databases, analytics, and the data platform
 *   Infra    — infrastructure: networking, storage, identity, management
 *   Compute  — compute: VMs, containers, serverless, HPC
 *
 * This same catalog grounds the meeting-prep AI action (the product names it is
 * allowed to reference), so keep names accurate and current.
 */

export const PRODUCT_LABELS = [
  { key: 'M365', name: 'M365', color: 'var(--danger)', hint: 'Microsoft 365 productivity & collaboration' },
  { key: 'AI', name: 'AI', color: 'var(--violet)', hint: 'AI, Copilot & machine learning' },
  { key: 'Azure', name: 'Azure', color: 'var(--accent)', hint: 'Azure cloud platform services' },
  { key: 'Cloud', name: 'Cloud', color: 'var(--accent)', hint: 'Cloud-hosted (SaaS/PaaS)' },
  { key: 'On-Prem', name: 'On-Prem', color: 'var(--violet)', hint: 'On-premises / customer-hosted' },
  { key: 'Data', name: 'Data', color: 'var(--success-text)', hint: 'Databases, analytics & data platform' },
  { key: 'Infra', name: 'Infra', color: 'var(--text-muted)', hint: 'Networking, storage, identity, management' },
  { key: 'Compute', name: 'Compute', color: 'var(--warning)', hint: 'VMs, containers, serverless, HPC' },
];

export const LABEL_KEYS = PRODUCT_LABELS.map((l) => l.key);

const LABEL_COLOR = Object.fromEntries(PRODUCT_LABELS.map((l) => [l.key, l.color]));

export function labelColor(key) {
  return LABEL_COLOR[key] || 'var(--text-muted)';
}

// category = display grouping on the page. labels = capability tags (chips).
export const MICROSOFT_PRODUCTS = [
  // ── AI & Copilot ──────────────────────────────────────────────────
  { name: 'Microsoft 365 Copilot', category: 'AI & Copilot', labels: ['M365', 'AI', 'Cloud'], description: 'Generative-AI assistant embedded across Word, Excel, PowerPoint, Outlook, and Teams.' },
  { name: 'Copilot Studio', category: 'AI & Copilot', labels: ['AI', 'Cloud', 'M365'], description: 'Low-code platform to build custom copilots and agents.' },
  { name: 'GitHub Copilot', category: 'AI & Copilot', labels: ['AI', 'Cloud'], description: 'AI pair-programmer for code completion, chat, and agents.' },
  { name: 'Security Copilot', category: 'AI & Copilot', labels: ['AI', 'Cloud'], description: 'Generative-AI assistant for security operations and incident response.' },
  { name: 'Copilot in Fabric', category: 'AI & Copilot', labels: ['AI', 'Data', 'Cloud'], description: 'AI assistance for data engineering, analytics, and Power BI in Microsoft Fabric.' },
  { name: 'Dynamics 365 Copilot', category: 'AI & Copilot', labels: ['AI', 'Cloud'], description: 'AI assistance across Dynamics 365 sales, service, and finance workflows.' },

  // ── Azure AI ──────────────────────────────────────────────────────
  { name: 'Azure OpenAI Service', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Enterprise access to OpenAI GPT, o-series, and embeddings models on Azure.' },
  { name: 'Azure AI Foundry', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Unified platform to build, evaluate, and deploy AI apps and agents.' },
  { name: 'Azure AI Services', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Prebuilt vision, speech, language, and decision APIs (formerly Cognitive Services).' },
  { name: 'Azure AI Search', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud', 'Data'], description: 'Vector and hybrid retrieval service for RAG and enterprise search.' },
  { name: 'Azure Machine Learning', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud', 'Data'], description: 'End-to-end MLOps platform to train, deploy, and manage models.' },
  { name: 'Azure AI Document Intelligence', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Extract text, tables, and structure from documents (formerly Form Recognizer).' },
  { name: 'Azure AI Vision', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Image analysis, OCR, and spatial analysis APIs.' },
  { name: 'Azure AI Speech', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Speech-to-text, text-to-speech, and speech translation.' },
  { name: 'Azure AI Language', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Natural-language understanding, summarization, and PII detection.' },
  { name: 'Azure AI Content Safety', category: 'Azure AI', labels: ['Azure', 'AI', 'Cloud'], description: 'Detect and moderate harmful text and image content.' },

  // ── Azure Compute ─────────────────────────────────────────────────
  { name: 'Azure Virtual Machines', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute', 'Infra'], description: 'On-demand, scalable Linux and Windows virtual machines.' },
  { name: 'Azure Virtual Machine Scale Sets', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute', 'Infra'], description: 'Auto-scaling groups of identical, load-balanced VMs.' },
  { name: 'Azure Kubernetes Service (AKS)', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Managed Kubernetes for containerized workloads.' },
  { name: 'Azure Container Apps', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Serverless containers with scale-to-zero and microservices support.' },
  { name: 'Azure Container Instances', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Run single containers without managing servers.' },
  { name: 'Azure App Service', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Fully managed hosting for web apps and APIs.' },
  { name: 'Azure Functions', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Event-driven serverless compute.' },
  { name: 'Azure Batch', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Large-scale parallel and batch compute jobs.' },
  { name: 'Azure VMware Solution', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute', 'Infra'], description: 'Run native VMware workloads on Azure infrastructure.' },
  { name: 'Azure Red Hat OpenShift', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Jointly managed OpenShift clusters on Azure.' },
  { name: 'Azure HPC', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'High-performance computing with InfiniBand-connected VMs.' },
  { name: 'Azure CycleCloud', category: 'Azure Compute', labels: ['Azure', 'Cloud', 'Compute'], description: 'Orchestrate and manage HPC clusters on Azure.' },

  // ── Data & Analytics ──────────────────────────────────────────────
  { name: 'Microsoft Fabric', category: 'Data & Analytics', labels: ['Data', 'Cloud', 'AI'], description: 'Unified analytics SaaS spanning data engineering, warehousing, and BI on OneLake.' },
  { name: 'Azure Synapse Analytics', category: 'Data & Analytics', labels: ['Azure', 'Data', 'Cloud'], description: 'Enterprise analytics across data warehousing and big data.' },
  { name: 'Azure Databricks', category: 'Data & Analytics', labels: ['Azure', 'Data', 'Cloud', 'AI'], description: 'Apache Spark-based lakehouse for data engineering and ML.' },
  { name: 'Power BI', category: 'Data & Analytics', labels: ['Data', 'Cloud', 'M365'], description: 'Self-service business intelligence and interactive dashboards.' },
  { name: 'Azure Data Factory', category: 'Data & Analytics', labels: ['Azure', 'Data', 'Cloud'], description: 'Cloud data integration and ETL/ELT pipelines.' },
  { name: 'Azure Data Lake Storage', category: 'Data & Analytics', labels: ['Azure', 'Data', 'Cloud', 'Infra'], description: 'Massively scalable storage optimized for big-data analytics.' },
  { name: 'Microsoft Purview', category: 'Data & Analytics', labels: ['Data', 'Cloud', 'Azure'], description: 'Unified data governance, cataloging, and compliance.' },
  { name: 'Azure Stream Analytics', category: 'Data & Analytics', labels: ['Azure', 'Data', 'Cloud'], description: 'Real-time analytics on streaming data.' },
  { name: 'Microsoft Sentinel', category: 'Data & Analytics', labels: ['Azure', 'Cloud', 'Data'], description: 'Cloud-native SIEM and SOAR for security analytics.' },

  // ── Databases ─────────────────────────────────────────────────────
  { name: 'Azure SQL Database', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'Fully managed relational database built on SQL Server.' },
  { name: 'Azure SQL Managed Instance', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'Managed SQL Server instance with near-full engine compatibility.' },
  { name: 'SQL Server', category: 'Databases', labels: ['On-Prem', 'Data'], description: 'Enterprise relational database engine for on-premises and hybrid.' },
  { name: 'Azure Arc-enabled Data Services', category: 'Databases', labels: ['Azure', 'Data', 'Cloud', 'On-Prem', 'Infra'], description: 'Run Azure SQL Managed Instance and PostgreSQL on any infrastructure.' },
  { name: 'Azure Cosmos DB', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'Globally distributed, multi-model NoSQL database.' },
  { name: 'Azure Database for PostgreSQL', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'Managed PostgreSQL with flexible server and elastic scale.' },
  { name: 'Azure Database for MySQL', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'Managed MySQL community edition.' },
  { name: 'Azure Cache for Redis', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'In-memory data cache for low-latency, high-throughput apps.' },
  { name: 'Azure Managed Instance for Apache Cassandra', category: 'Databases', labels: ['Azure', 'Data', 'Cloud'], description: 'Managed, hybrid Apache Cassandra clusters.' },

  // ── Storage, Networking & Infrastructure ──────────────────────────
  { name: 'Azure Blob Storage', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra', 'Data'], description: 'Massively scalable object storage for unstructured data.' },
  { name: 'Azure Files', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Fully managed SMB and NFS file shares in the cloud.' },
  { name: 'Azure NetApp Files', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Enterprise NFS/SMB file storage powered by NetApp ONTAP.' },
  { name: 'Azure Backup', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Centralized backup for VMs, databases, and workloads.' },
  { name: 'Azure Site Recovery', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Disaster recovery and replication for business continuity.' },
  { name: 'Azure Virtual Network', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Private, isolated networking for Azure resources.' },
  { name: 'Azure Load Balancer', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'High-performance layer-4 load balancing.' },
  { name: 'Azure Application Gateway', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Layer-7 load balancer with WAF for web traffic.' },
  { name: 'Azure Firewall', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Managed, cloud-native network firewall.' },
  { name: 'Azure ExpressRoute', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Private, dedicated connectivity from on-premises to Azure.' },
  { name: 'Azure Front Door', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Global CDN, load balancing, and edge security.' },
  { name: 'Azure DNS', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Hosting for DNS domains with fast, reliable resolution.' },
  { name: 'Azure Monitor', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Full-stack observability: metrics, logs, and alerts.' },
  { name: 'Azure API Management', category: 'Storage, Networking & Infrastructure', labels: ['Azure', 'Cloud', 'Infra'], description: 'Publish, secure, and govern APIs at scale.' },

  // ── Identity & Security ───────────────────────────────────────────
  { name: 'Microsoft Entra ID', category: 'Identity & Security', labels: ['Cloud', 'Infra', 'M365'], description: 'Cloud identity and access management (formerly Azure AD).' },
  { name: 'Microsoft Entra ID Governance', category: 'Identity & Security', labels: ['Cloud', 'Infra'], description: 'Identity lifecycle, access reviews, and entitlement management.' },
  { name: 'Microsoft Defender for Cloud', category: 'Identity & Security', labels: ['Azure', 'Cloud', 'Infra'], description: 'Cloud security posture management and workload protection.' },
  { name: 'Microsoft Defender XDR', category: 'Identity & Security', labels: ['Cloud', 'M365'], description: 'Unified pre- and post-breach defense across endpoints, identity, and email.' },
  { name: 'Microsoft Intune', category: 'Identity & Security', labels: ['Cloud', 'M365', 'Infra'], description: 'Cloud-based endpoint and mobile device management.' },

  // ── Microsoft 365 & Productivity ──────────────────────────────────
  { name: 'Microsoft Teams', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Chat, meetings, calling, and collaboration hub.' },
  { name: 'Microsoft 365 Apps', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Word, Excel, PowerPoint, and Outlook across desktop and web.' },
  { name: 'Exchange Online', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Cloud-hosted enterprise email and calendaring.' },
  { name: 'SharePoint Online', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Content management, intranet, and document collaboration.' },
  { name: 'OneDrive', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Cloud file storage and sharing.' },
  { name: 'Microsoft Loop', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Collaborative canvas with portable, live components.' },
  { name: 'Microsoft Viva', category: 'Microsoft 365 & Productivity', labels: ['M365', 'Cloud'], description: 'Employee experience platform for engagement and learning.' },

  // ── Power Platform & Dynamics ─────────────────────────────────────
  { name: 'Power Apps', category: 'Power Platform & Dynamics', labels: ['Cloud', 'M365'], description: 'Low-code platform to build business apps.' },
  { name: 'Power Automate', category: 'Power Platform & Dynamics', labels: ['Cloud', 'M365'], description: 'Workflow automation and robotic process automation.' },
  { name: 'Power Pages', category: 'Power Platform & Dynamics', labels: ['Cloud', 'M365'], description: 'Low-code external-facing business websites.' },
  { name: 'Dynamics 365 Sales', category: 'Power Platform & Dynamics', labels: ['Cloud'], description: 'CRM for sales pipeline and relationship management.' },
  { name: 'Dynamics 365 Customer Service', category: 'Power Platform & Dynamics', labels: ['Cloud'], description: 'Omnichannel customer support and case management.' },
  { name: 'Dynamics 365 Finance', category: 'Power Platform & Dynamics', labels: ['Cloud'], description: 'Financial management and operations ERP.' },
  { name: 'Dynamics 365 Business Central', category: 'Power Platform & Dynamics', labels: ['Cloud'], description: 'All-in-one ERP for small and midsize businesses.' },

  // ── On-Premises & Hybrid ──────────────────────────────────────────
  { name: 'Windows Server', category: 'On-Premises & Hybrid', labels: ['On-Prem', 'Infra', 'Compute'], description: 'Server OS for on-premises and hybrid workloads.' },
  { name: 'Azure Arc', category: 'On-Premises & Hybrid', labels: ['Azure', 'Cloud', 'On-Prem', 'Infra'], description: 'Extend Azure management and governance to any infrastructure.' },
  { name: 'Azure Stack HCI', category: 'On-Premises & Hybrid', labels: ['Azure', 'On-Prem', 'Infra', 'Compute'], description: 'Hyperconverged infrastructure for on-premises virtualization.' },
  { name: 'Azure Local', category: 'On-Premises & Hybrid', labels: ['Azure', 'On-Prem', 'Infra', 'Compute'], description: 'Azure-connected on-premises infrastructure for distributed locations.' },
  { name: 'Exchange Server', category: 'On-Premises & Hybrid', labels: ['On-Prem'], description: 'On-premises enterprise email and calendaring server.' },
  { name: 'SharePoint Server', category: 'On-Premises & Hybrid', labels: ['On-Prem'], description: 'On-premises content management and collaboration server.' },
  { name: 'Windows 11 Enterprise', category: 'On-Premises & Hybrid', labels: ['On-Prem', 'M365'], description: 'Enterprise client OS with advanced security and management.' },

  // ── Developer & DevOps ────────────────────────────────────────────
  { name: 'GitHub', category: 'Developer & DevOps', labels: ['Cloud', 'AI'], description: 'Source control, CI/CD, and collaboration platform.' },
  { name: 'GitHub Advanced Security', category: 'Developer & DevOps', labels: ['Cloud'], description: 'Code, secret, and dependency scanning built into GitHub.' },
  { name: 'Azure DevOps', category: 'Developer & DevOps', labels: ['Azure', 'Cloud'], description: 'Boards, Repos, Pipelines, and Artifacts for the SDLC.' },
  { name: 'Visual Studio', category: 'Developer & DevOps', labels: ['On-Prem'], description: 'Integrated development environment for building applications.' },
  { name: 'Azure Arc-enabled Kubernetes', category: 'Developer & DevOps', labels: ['Azure', 'Cloud', 'On-Prem', 'Compute', 'Infra'], description: 'Attach and govern any Kubernetes cluster from Azure.' },

  // ── Integration & Messaging ───────────────────────────────────────
  { name: 'Azure Logic Apps', category: 'Integration & Messaging', labels: ['Azure', 'Cloud', 'Compute'], description: 'Serverless workflow orchestration and integration.' },
  { name: 'Azure Service Bus', category: 'Integration & Messaging', labels: ['Azure', 'Cloud', 'Infra', 'Data'], description: 'Enterprise messaging with queues and publish/subscribe topics.' },
  { name: 'Azure Event Hubs', category: 'Integration & Messaging', labels: ['Azure', 'Cloud', 'Data', 'Infra'], description: 'Big-data streaming and event ingestion at scale.' },
  { name: 'Azure Event Grid', category: 'Integration & Messaging', labels: ['Azure', 'Cloud', 'Infra'], description: 'Reactive, event-driven routing across services.' },
];

// Compact grounding payload for the meeting-prep AI action: name + labels only.
export function productCatalogForPrompt() {
  return MICROSOFT_PRODUCTS.map((p) => ({ name: p.name, labels: p.labels }));
}

// Canonical Microsoft Learn documentation landing page for each product.
// Base learn.microsoft.com URLs are used deliberately — they auto-redirect to the
// visitor's locale (e.g. /en-us/) when opened in a browser. A few entries deep-link
// to a specific overview page where the product's root path 404s or redirects to a
// generic hub (e.g. Loop, Azure OpenAI, AI Services, GitHub Advanced Security).
// Every URL was verified to resolve to the matching product's documentation, not
// merely to return HTTP 200. Keep keys in sync with the product names above.
export const PRODUCT_LEARN_URLS = {
  // AI & Copilot
  'Microsoft 365 Copilot': 'https://learn.microsoft.com/copilot/microsoft-365/',
  'Copilot Studio': 'https://learn.microsoft.com/microsoft-copilot-studio/',
  'GitHub Copilot': 'https://docs.github.com/copilot',
  'Security Copilot': 'https://learn.microsoft.com/copilot/security/',
  'Copilot in Fabric': 'https://learn.microsoft.com/fabric/fundamentals/copilot-fabric-overview',
  'Dynamics 365 Copilot': 'https://learn.microsoft.com/dynamics365/copilot/',

  // Azure AI
  'Azure OpenAI Service': 'https://learn.microsoft.com/azure/ai-services/openai/overview',
  'Azure AI Foundry': 'https://learn.microsoft.com/azure/ai-foundry/',
  'Azure AI Services': 'https://learn.microsoft.com/azure/ai-services/what-are-ai-services',
  'Azure AI Search': 'https://learn.microsoft.com/azure/search/',
  'Azure Machine Learning': 'https://learn.microsoft.com/azure/machine-learning/',
  'Azure AI Document Intelligence': 'https://learn.microsoft.com/azure/ai-services/document-intelligence/',
  'Azure AI Vision': 'https://learn.microsoft.com/azure/ai-services/computer-vision/',
  'Azure AI Speech': 'https://learn.microsoft.com/azure/ai-services/speech-service/',
  'Azure AI Language': 'https://learn.microsoft.com/azure/ai-services/language-service/',
  'Azure AI Content Safety': 'https://learn.microsoft.com/azure/ai-services/content-safety/',

  // Azure Compute
  'Azure Virtual Machines': 'https://learn.microsoft.com/azure/virtual-machines/',
  'Azure Virtual Machine Scale Sets': 'https://learn.microsoft.com/azure/virtual-machine-scale-sets/',
  'Azure Kubernetes Service (AKS)': 'https://learn.microsoft.com/azure/aks/',
  'Azure Container Apps': 'https://learn.microsoft.com/azure/container-apps/',
  'Azure Container Instances': 'https://learn.microsoft.com/azure/container-instances/',
  'Azure App Service': 'https://learn.microsoft.com/azure/app-service/',
  'Azure Functions': 'https://learn.microsoft.com/azure/azure-functions/',
  'Azure Batch': 'https://learn.microsoft.com/azure/batch/',
  'Azure VMware Solution': 'https://learn.microsoft.com/azure/azure-vmware/',
  'Azure Red Hat OpenShift': 'https://learn.microsoft.com/azure/openshift/',
  'Azure HPC': 'https://learn.microsoft.com/azure/high-performance-computing/',
  'Azure CycleCloud': 'https://learn.microsoft.com/azure/cyclecloud/',

  // Data & Analytics
  'Microsoft Fabric': 'https://learn.microsoft.com/fabric/',
  'Azure Synapse Analytics': 'https://learn.microsoft.com/azure/synapse-analytics/',
  'Azure Databricks': 'https://learn.microsoft.com/azure/databricks/',
  'Power BI': 'https://learn.microsoft.com/power-bi/',
  'Azure Data Factory': 'https://learn.microsoft.com/azure/data-factory/',
  'Azure Data Lake Storage': 'https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction',
  'Microsoft Purview': 'https://learn.microsoft.com/purview/',
  'Azure Stream Analytics': 'https://learn.microsoft.com/azure/stream-analytics/',
  'Microsoft Sentinel': 'https://learn.microsoft.com/azure/sentinel/',

  // Databases
  'Azure SQL Database': 'https://learn.microsoft.com/azure/azure-sql/database/',
  'Azure SQL Managed Instance': 'https://learn.microsoft.com/azure/azure-sql/managed-instance/',
  'SQL Server': 'https://learn.microsoft.com/sql/sql-server/',
  'Azure Arc-enabled Data Services': 'https://learn.microsoft.com/azure/azure-arc/data/',
  'Azure Cosmos DB': 'https://learn.microsoft.com/azure/cosmos-db/',
  'Azure Database for PostgreSQL': 'https://learn.microsoft.com/azure/postgresql/',
  'Azure Database for MySQL': 'https://learn.microsoft.com/azure/mysql/',
  'Azure Cache for Redis': 'https://learn.microsoft.com/azure/azure-cache-for-redis/',
  'Azure Managed Instance for Apache Cassandra': 'https://learn.microsoft.com/azure/managed-instance-apache-cassandra/',

  // Storage, Networking & Infrastructure
  'Azure Blob Storage': 'https://learn.microsoft.com/azure/storage/blobs/',
  'Azure Files': 'https://learn.microsoft.com/azure/storage/files/',
  'Azure NetApp Files': 'https://learn.microsoft.com/azure/azure-netapp-files/',
  'Azure Backup': 'https://learn.microsoft.com/azure/backup/',
  'Azure Site Recovery': 'https://learn.microsoft.com/azure/site-recovery/',
  'Azure Virtual Network': 'https://learn.microsoft.com/azure/virtual-network/',
  'Azure Load Balancer': 'https://learn.microsoft.com/azure/load-balancer/',
  'Azure Application Gateway': 'https://learn.microsoft.com/azure/application-gateway/',
  'Azure Firewall': 'https://learn.microsoft.com/azure/firewall/',
  'Azure ExpressRoute': 'https://learn.microsoft.com/azure/expressroute/',
  'Azure Front Door': 'https://learn.microsoft.com/azure/frontdoor/',
  'Azure DNS': 'https://learn.microsoft.com/azure/dns/',
  'Azure Monitor': 'https://learn.microsoft.com/azure/azure-monitor/',
  'Azure API Management': 'https://learn.microsoft.com/azure/api-management/',

  // Identity & Security
  'Microsoft Entra ID': 'https://learn.microsoft.com/entra/identity/',
  'Microsoft Entra ID Governance': 'https://learn.microsoft.com/entra/id-governance/',
  'Microsoft Defender for Cloud': 'https://learn.microsoft.com/azure/defender-for-cloud/',
  'Microsoft Defender XDR': 'https://learn.microsoft.com/defender-xdr/',
  'Microsoft Intune': 'https://learn.microsoft.com/mem/intune/',

  // Microsoft 365 & Productivity
  'Microsoft Teams': 'https://learn.microsoft.com/microsoftteams/',
  'Microsoft 365 Apps': 'https://learn.microsoft.com/microsoft-365-apps/',
  'Exchange Online': 'https://learn.microsoft.com/exchange/exchange-online',
  'SharePoint Online': 'https://learn.microsoft.com/sharepoint/',
  'OneDrive': 'https://learn.microsoft.com/onedrive/',
  'Microsoft Loop': 'https://learn.microsoft.com/microsoft-365/loop/loop-admin-configuration',
  'Microsoft Viva': 'https://learn.microsoft.com/viva/',

  // Power Platform & Dynamics
  'Power Apps': 'https://learn.microsoft.com/power-apps/',
  'Power Automate': 'https://learn.microsoft.com/power-automate/',
  'Power Pages': 'https://learn.microsoft.com/power-pages/',
  'Dynamics 365 Sales': 'https://learn.microsoft.com/dynamics365/sales/',
  'Dynamics 365 Customer Service': 'https://learn.microsoft.com/dynamics365/customer-service/',
  'Dynamics 365 Finance': 'https://learn.microsoft.com/dynamics365/finance/',
  'Dynamics 365 Business Central': 'https://learn.microsoft.com/dynamics365/business-central/',

  // On-Premises & Hybrid
  'Windows Server': 'https://learn.microsoft.com/windows-server/',
  'Azure Arc': 'https://learn.microsoft.com/azure/azure-arc/',
  'Azure Stack HCI': 'https://learn.microsoft.com/azure-stack/hci/',
  'Azure Local': 'https://learn.microsoft.com/azure/azure-local/',
  'Exchange Server': 'https://learn.microsoft.com/exchange/',
  'SharePoint Server': 'https://learn.microsoft.com/sharepoint/sharepoint-server',
  'Windows 11 Enterprise': 'https://learn.microsoft.com/windows/',

  // Developer & DevOps
  'GitHub': 'https://docs.github.com/',
  'GitHub Advanced Security': 'https://docs.github.com/get-started/learning-about-github/about-github-advanced-security',
  'Azure DevOps': 'https://learn.microsoft.com/azure/devops/',
  'Visual Studio': 'https://learn.microsoft.com/visualstudio/',
  'Azure Arc-enabled Kubernetes': 'https://learn.microsoft.com/azure/azure-arc/kubernetes/',

  // Integration & Messaging
  'Azure Logic Apps': 'https://learn.microsoft.com/azure/logic-apps/',
  'Azure Service Bus': 'https://learn.microsoft.com/azure/service-bus-messaging/',
  'Azure Event Hubs': 'https://learn.microsoft.com/azure/event-hubs/',
  'Azure Event Grid': 'https://learn.microsoft.com/azure/event-grid/',
};

// Returns the Microsoft Learn documentation URL for a product name, or null if none
// is mapped (callers should not render a link when null — no silent fallbacks).
export function learnUrl(name) {
  return PRODUCT_LEARN_URLS[name] || null;
}
