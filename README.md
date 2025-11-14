# **Automatische MonsterASP Back-up — Render → NAS → Bridge Mail**

## **1. Overzicht**

Het back-upsysteem bestaat uit **vier hoofdcomponenten**:

### **1. Render (Node.js Bridge-app)**

- Verbindt via SFTP met MonsterASP
- Downloadt de nieuwste `.zpaq`-back-up
- Uploadt naar de Synology NAS via WebDAV
- Verwijdert automatisch oude back-ups (houdt de laatste 3)
- Stuurt een webhook naar de ASP.NET Bridge-app

### **2. Cron-job.org (Daily Trigger)**

- Roept 1× per dag de Render-URL aan
- Start daarmee de volledige back-upketen

### **3. Synology NAS — Keepalive Cron Job**

- Roept elke 10 minuten de `/run`-URL van Render aan
- Houdt de Render-container wakker
- Voorkomt Render “cold starts” en timeouts
- Verhoogt betrouwbaarheid van de dagelijkse back-up

### **4. ASP.NET MVC Bridge (Mail Dispatcher)**

- Ontvangt webhook-status van Render
- Verstuurt OK/ERR HTML-mails
- Filtert dubbele webhook-calls met idempotentie

---

## **2. Component 1 — Render (SFTP → NAS Bridge)**

1. Verbindt met MonsterASP via SFTP  
2. Zoekt de nieuwste `.zpaq`-file  
3. Downloadt naar `/tmp/backups`  
4. Genereert een unieke naam met timestamp  
5. Uploadt naar de NAS via WebDAV  
6. Voert PROPFIND uit op NAS  
7. Houdt de 3 nieuwste, verwijdert de rest  
8. Stuurt webhook naar Bridge-app  

**Endpoint**

```
https://monsterasp-sftp-bridge.onrender.com/run
```

**Environment Variables**

| Naam | Beschrijving |
|------|--------------|
| SFTP_USER | MonsterASP SFTP gebruikersnaam |
| SFTP_PASS | MonsterASP SFTP wachtwoord |
| NAS_URL | WebDAV-URL van de Synology map |
| NAS_USER | NAS WebDAV gebruiker |
| NAS_PASS | NAS WebDAV wachtwoord |
| MAIL_WEBHOOK_URL | URL naar de Bridge-controller |

---

## **3. Component 2 — Cron-job.org (Daily Trigger)**

- HTTPS GET naar `/run`
- 1× per dag
- Bridge-app filtert duplicaten

---

## **4. Component 3 — NAS Keepalive Cron Job**

- URL: https://monsterasp-sftp-bridge.onrender.com/
- Frequentie: elke 10 minuten
- Houdt Render actief

---

## **5. Component 4 — ASP.NET MVC Bridge (Mail Dispatcher)**

**Webhook Endpoint**

```
https://testparodata.runasp.net/Bridge/SendStatusMail
```

**Voorbeeld JSON**

```json
{
  "type": "OK",
  "filename": "db18386_WEEK2_2025-11-13-18-45-10.zpaq",
  "sizeBytes": 20351571,
  "sha1": "15a2fad...",
  "time": "2025-11-13T18:45:12Z"
}
```

**Idempotentie**

```vbnet
Private Shared _lastFile As String = Nothing

If _lastFile = data.filename Then
    Return Json(New With {.result = "OK", .info = "duplicate ignored"})
End If
```

---

## **6. Architectuur**

```
NAS Keepalive (elke 10 min)
       │
       ▼
Render /run
       │
       ├── MonsterASP SFTP download
       ├── NAS WebDAV upload
       └── Webhook → Bridge
                       │
                       ▼
                  E-mail melding

Cron-job.org (1× per dag)
       │
       └── Start dagelijkse back-up
```

---

## **7. Monitoring**

- Render logs  
- Bridge Webhook logs  
- Cron-job.org logs  
- NAS taakplanning (keepalive)  

---

## **8. Samenvatting**

- Render voert de volledige SFTP → NAS back-up uit  
- NAS houdt Render warm (keepalive)  
- Cron-job.org triggert dagelijks  
- Bridge stuurt exact één statusmail  
- Automatische cleaning van oude bestanden  
