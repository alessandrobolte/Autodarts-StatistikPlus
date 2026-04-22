{
  "manifest_version": 3,
  "name": "Statistik + für play.autodarts.io",
  "description": "Eigenständiges Statistik-Dashboard für play.autodarts.io mit lokaler Historie, KPIs, Charts, Treffer je Feld und Top-Tabellen.",
  "version": "0.4.29",
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "content_scripts": [
    {
      "matches": [
        "https://play.autodarts.io/*"
      ],
      "js": [
        "src/boot.js"
      ],
      "run_at": "document_start"
    },
    {
      "matches": [
        "https://play.autodarts.io/*"
      ],
      "js": [
        "src/core.js",
        "src/db.js",
        "src/stats.js",
        "src/ui.js",
        "src/collector.js",
        "src/content.js"
      ],
      "css": [
        "src/content.css"
      ],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": [
        "src/page-bridge.js"
      ],
      "matches": [
        "https://play.autodarts.io/*"
      ]
    }
  ],
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwU4QPFn1WZJp3SKYrK+aq9hsGeIQfKoQw+Nph8wcCJDjf+oRxvTJp/wkAh3Br/ui1sSE8LlMRRSbdTDMLz24syDd3cv9PFytdggI3E1iC3jAw+vXjNNnQ6jDgZ3l036G+zJO5Oun1z7MVM/4WkBk90ghQkKa7FMZDxV7GKM2PAIyTuJbuRGscgkQeNnZeMICkRc3pN3qrd1l2lOx8Lpr9qAoWhbVsDq9HpIaRHS2R82C/f/+gDleu6drrJqUHEhJdnQrWoaBNN3ZgoranDMISuRqnC2PGBnQWIWGfBFgULpsGjVrUp5lSMmd8vja8wxGsM+epkyVbS0GZdwdrQZQMQIDAQAB",
  "update_url": "https://raw.githubusercontent.com/Boltotelli/Autodarts-StatistikPlus/main/update.xml"
}
