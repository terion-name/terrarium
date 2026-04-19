import { defineConfig } from "vitepress";

const base = process.env.GITHUB_ACTIONS ? "/terrarium/" : "/";

export default defineConfig({
  title: "Terrarium",
  description: "Secure, rewindable VPS environments for agents, dev tools, and isolated apps.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "About", link: "/about/" },
      { text: "Getting Started", link: "/getting-started/" },
      { text: "Guides", link: "/guides/" },
      { text: "Operations", link: "/operations/" },
      { text: "Reference", link: "/reference/" },
      { text: "GitHub", link: "https://github.com/terion-name/terrarium" }
    ],
    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "About", link: "/about" },
          { text: "Security Model", link: "/security" },
          { text: "Architecture", link: "/architecture" }
        ]
      },
      {
        text: "Getting Started",
        items: [
          { text: "Overview", link: "/getting-started/" },
          { text: "Installation", link: "/getting-started/installation" },
          { text: "Storage and Sizing", link: "/getting-started/storage" },
          { text: "Domains and Authentication", link: "/getting-started/domains-and-auth" },
          { text: "Management GUIs", link: "/getting-started/management-guis" },
          { text: "Shared Data Between Containers", link: "/getting-started/shared-data-between-containers" },
          { text: "External Shared Storage", link: "/getting-started/external-shared-storage" }
        ]
      },
      {
        text: "Operations",
        items: [
          { text: "Overview", link: "/operations/" },
          { text: "Reconfiguration", link: "/operations/reconfiguration" },
          { text: "Backups and Restore", link: "/operations/backups-and-restore" }
        ]
      },
      {
        text: "Reference",
        items: [
          { text: "Overview", link: "/reference/" },
          { text: "Services and Endpoints", link: "/reference/services-and-endpoints" },
          { text: "terrariumctl", link: "/reference/terrariumctl" }
        ]
      },
      {
        text: "Guides",
        items: [
          { text: "Overview", link: "/guides/" },
          { text: "OpenClaw", link: "/guides/openclaw" },
          { text: "Hermes", link: "/guides/hermes" },
          { text: "VSCodium Web IDE", link: "/guides/vscode" },
          { text: "Isolated Docker Compose deployments", link: "/guides/compose" },
          { text: "Protecting published services with OIDC", link: "/guides/auth-protection" }
        ]
      },
      {
        text: "Providers",
        items: [
          { text: "Overview", link: "/providers/" },
          { text: "DigitalOcean", link: "/providers/digitalocean" },
          { text: "Vultr", link: "/providers/vultr" },
          { text: "Hetzner Cloud", link: "/providers/hetzner" },
          { text: "Hostinger", link: "/providers/hostinger" }
        ]
      }
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/terion-name/terrarium" }
    ],
    search: {
      provider: "local"
    },
    footer: {
      message: "Built with VitePress",
      copyright: "Terrarium"
    }
  }
});
