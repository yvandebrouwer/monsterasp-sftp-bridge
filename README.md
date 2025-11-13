# **Automatische MonsterASP Back-up — Render → NAS → Bridge Mail**

## **1. Overzicht**

Het back-upsysteem bestaat uit **drie hoofdcomponenten**:

### **1. Render (Node.js Bridge-app)**

- Verbindt via SFTP met MonsterASP
- Downloadt de nieuwste `.zpaq`-back-up
- Uploadt naar de Synology NAS via WebDAV
- Verwijdert automatisch oude back-ups (houdt de laatste 3)
- Stuurt een webhook naar de ASP.NET Bridge-app

### **2. Cron-job.org**

- Roept 1× per dag de Render-URL aan
- Start daarmee de volledige back-upketen

### **3. ASP.NET MVC Bridge (Mail Dispatcher)**

- Ontvangt webhook-status van Render
- Verstuurt OK/ERR HTML-mails
- Filtert dubbele webhook-calls met idempotentie

---

## **2. Component 1 — Render (SFTP → NAS Bridge)**

De Render-app voert het volledige proces uit:

1. Verbindt met MonsterASP via SFTP
2. Zoekt de nieuwste `.zpaq`-file
3. Downloadt naar `/tmp/backups`
4. Genereert een unieke naam met timestamp
5. Uploadt naar de NAS via WebDAV
6. Doet PROPFIND om oude bestanden op te sporen
7. Houdt de 3 nieuwste, verwijdert de rest
8. Stuurt een webhook (OK/ERR) naar de Bridge-app

### **Endpoint**

```
https://monsterasp-sftp-bridge.onrender.com/run
```

### **Environment Variables**

| Naam                 | Beschrijving                        |
|----------------------|-------------------------------------|
| **SFTP_USER**        | MonsterASP SFTP gebruikersnaam      |
| **SFTP_PASS**        | MonsterASP SFTP wachtwoord          |
| **NAS_URL**          | WebDAV-URL van de Synology map      |
| **NAS_USER**         | NAS WebDAV gebruiker                |
| **NAS_PASS**         | NAS WebDAV wachtwoord               |
| **MAIL_WEBHOOK_URL** | URL naar de Bridge-controller       |

### **GitHub → Render Deployment**

Render bouwt automatisch bij elke git push naar de GitHub-repo.

---

## **3. Component 2 — Cron-job.org (Planning)**

Cron-job.org vervangt oude Google Apps Script triggers.

### **Dagelijkse schedule**

- Methode: **HTTPS GET**
- Frequentie: **1× per dag**
- Endpoint: `/run` op Render

Cron-job.org doet soms retries bij cold-starts → de Bridge-app filtert duplicaten.

---

## **4. Component 3 — ASP.NET MVC Bridge (Mail Dispatcher)**

De Bridge ontvangt webhook-calls van Render en stuurt een HTML-mail.

### **Webhook Endpoint**

```
https://testparodata.runasp.net/Bridge/SendStatusMail
```

### **Voorbeeld JSON (OK)**

```json
{
  "type": "OK",
  "filename": "db18386_WEEK2_2025-11-13-18-45-10.zpaq",
  "sizeBytes": 20351571,
  "sha1": "15a2fad...",
  "time": "2025-11-13T18:45:12Z"
}
```

### **Mail-handling**

- HTML mails (OK / ERR)
- Verstuurd via Gmail SMTP (App Password)
- Naar de beheerder

### **Idempotentie (tegen dubbele mails)**

```vbnet
Private Shared _lastFile As String = Nothing

If _lastFile = data.filename Then
    Return Json(New With {.result = "OK", .info = "duplicate ignored"})
End If
```

➡️ **Geen dubbele mails**, zelfs bij meerdere webhook-calls.

---

## **5. NAS Cleanup (Automatisch)**

Het systeem:

1. Voert PROPFIND uit
2. Parseert `.zpaq`-bestanden
3. Sorteert op datum
4. Houdt de 3 nieuwste
5. Verwijdert oudere bestanden automatisch

---

## **6. Architectuur (High-Level)**

```
cron-job.org  
       │
       ▼
Render /run  
       │
       ├── SFTP → MonsterASP (download)
       ├── WebDAV → NAS (upload)
       └── Webhook → Bridge (status)
                          │
                          ▼
                     E-mail melding
```

---

## **7. Opslag & Kosten**

### **Render Free Tier**

- 750 compute-uren / maand
- Auto-sleep → gratis
- Tijdelijke opslag in `/tmp`

### **NAS**

- Permanente opslag
- Automatische rotatie door Render

### **Geen Google Apps Script / Google Drive**

Helemaal verwijderd uit architectuur.

---

## **8. Monitoring**

### **Render Logs**

- Download status
- Upload resultaten
- Cleanup acties
- Webhook success/failure

### **Bridge Logs**

- Webhook ontvangen
- Duplicate ignored
- Mail errors

### **Cron-job.org**

- Success/failure per run

---

## **9. Samenvatting**

- Render doet volledige SFTP → NAS back-up
- Cron-job.org triggert het proces dagelijks
- Bridge stuurt **exact één** mail dankzij idempotentie
- Oude back-ups automatisch verwijderd
- Geen dubbele mails
- Geen Google-services meer
- Volledig autonoom & gratis
