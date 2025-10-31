# Documentatie: Automatische MonsterASP Back-up via Render en Google Apps Script

Deze documentatie beschrijft stap voor stap hoe de automatische back-upoplossing werkt voor de MonsterASP-omgeving. Het systeem combineert Render (voor SFTP-downloads) met Google Apps Script (voor planning en opslag in Google Drive).

## 1\. Overzicht van de oplossing

Het systeem bestaat uit twee componenten:  
1\. Render (Node.js-webservice): haalt dagelijks de laatste .zpaq-databaseback-up op via SFTP vanaf MonsterASP.  
2\. Google Apps Script: roept dagelijks de Render-service aan, ontvangt het back-upbestand en slaat het automatisch op in Google Drive.  
<br/>Deze aanpak combineert de kracht van een server (Render) met de eenvoud en gratis opslag van Google Drive, zonder dat er Google Cloud API's of service accounts nodig zijn.

## 2\. Component 1 - Render (SFTP Bridge)

Render draait een kleine Node.js-webservice (de 'bridge'). Deze service logt in op MonsterASP via SFTP, vindt de nieuwste .zpaq-back-up in de rootdirectory en stuurt die terug via HTTP. De Google Apps Script kan dit bestand vervolgens direct ophalen en in Drive opslaan.  
<br/>Render gebruikt hiervoor de gratis 'Free Web Service'-tier. De service wordt enkel kort actief wanneer Apps Script de URL oproept en gaat daarna automatisch in slaapmodus, waardoor het binnen de gratis limieten blijft.

De belangrijkste endpoint op Render is:

<https://monsterasp-sftp-bridge-i7as.onrender.com/run>

Wanneer deze URL wordt aangeroepen, downloadt de service het laatste back-upbestand en geeft het terug als download.

Het account bij Render is via het Google account van <nicolaas.secret@gmail.com>

## 3\. Component 2 - Google Apps Script (Trigger & Opslag)

Google Apps Script roept dagelijks automatisch de Render-URL aan. De response bevat het daadwerkelijke .zpaq-bestand, dat door het script wordt opgeslagen in een vaste map op Google Drive ('MonsterASP-Backups').

### Apps Script Code

Belangrijkste functies:  
• getMonsterBackup(): roept Render aan, ontvangt de back-up en bewaart die in Drive.  
• getOrCreateFolder(): zorgt ervoor dat de map 'MonsterASP-Backups' bestaat.  
<br/>Het script draait volledig in het persoonlijke Google-account en gebruikt enkel Drive-toestemming. Er zijn geen API-sleutels of service accounts nodig.

Het Google App Script 'Backups ParoData' loopt via het Google account van <nicolaas.secret@gmail.com>

## 4\. Automatische uitvoering

In de Google Apps Script-interface wordt een tijdgestuurde trigger ingesteld:  
• Functie: getMonsterBackup  
• Frequentie: Dagelijks  
• Tijd: bijvoorbeeld 03:00  
<br/>Zo wordt elke nacht automatisch de meest recente MonsterASP-back-up gedownload en opgeslagen in Google Drive.

## 5\. Opslag en onderhoud

De bestanden worden opgeslagen in de map 'MonsterASP-Backups' in Google Drive.  
Render zelf bewaart niets permanent; alle downloads gebeuren tijdelijk in /tmp. Daarom is de combinatie met Drive essentieel voor duurzame opslag.  
<br/>Optioneel kan het script later uitgebreid worden om oudere back-ups automatisch te verwijderen of meerdere bestanden tegelijk te downloaden.

## 6\. Kosten en limieten

Render Free Tier:  
• 750 compute-uren per maand (ruim voldoende voor 1-2 aanroepen per dag)  
• 512 MB RAM, 0.1 CPU  
• Tijdelijke opslag in /tmp (ca. 500 MB)  
• Geen creditcard vereist  
<br/>Google Apps Script en Drive zijn eveneens volledig gratis binnen normale gebruikslimieten.

## 7\. Samenvatting van de gegevensstroom

1\. Google Apps Script activeert Render via HTTPS.  
2\. Render logt in op MonsterASP via SFTP.  
3\. Render downloadt de nieuwste back-up.  
4\. Render stuurt het bestand terug via HTTP.  
5\. Apps Script ontvangt en slaat het bestand op in Google Drive.  
<br/>Resultaat: dagelijkse, automatische back-up zonder handmatige tussenkomst, volledig gratis.

## 8\. Beheer en controle

• Logs in Apps Script tonen of de back-up succesvol is opgeslagen.  
• In Google Drive kan gecontroleerd worden of het .zpaq-bestand aanwezig is in de map 'MonsterASP-Backups'.  
• Eventuele fouten (zoals SFTP time-outs of verkeerde credentials) verschijnen in de Render logs.

## 9\. Technische Architectuur en Samenhang GitHub - Render - Google Apps Script

### 9.1 Componenten

Het systeem bestaat uit drie hoofdcomponenten:

| Component | Rol | Technologie |
| --- | --- | --- |
| GitHub | Bevat de broncode van de SFTP-bridge (Node.js-app) | Git-repository |
| Render | Host en voert de bridge-applicatie automatisch uit | Cloud-container (Free plan) |
| Google Apps Script | Start de back-up op vaste tijdstippen en bewaart resultaten | Google Cloud Script (JavaScript) |

Samen vormen deze onderdelen een geautomatiseerde keten die zonder manuele tussenkomst elke dag een database-back-up ophaalt van MonsterASP en opslaat in Google Drive.  

### 9.2 Processtroom

1\. MonsterASP genereert dagelijks een .zpaq-back-up op de hostingserver.  
2\. De Render-bridge verbindt via SFTP met MonsterASP en haalt het meest recente .zpaq-bestand op.  
\- Het bestand wordt tijdelijk opgeslagen in /tmp/backups.  
\- De HTTP-response bevat het bestand en een header X-Backup-Date met de originele bestandsdatum.  
3\. Google Apps Script roept dagelijks het endpoint /run aan, leest de header uit en slaat het bestand op in Drive.  
4\. Een tweede Apps Script-functie wakeUpRender() pingt elk uur Render om de container wakker te houden.  
5\. GitHub fungeert als broncodebeheer en triggert automatische builds bij Render bij elke git push.  

### 9.3 Dataflow

### 9.4 Belangrijke verbindingen

| Verbinding | Protocol | Authenticatie | Frequentie |
| --- | --- | --- | --- |
| Apps Script → Render | HTTPS (GET) | openbaar endpoint | Dagelijks / elk uur |
| Render → MonsterASP | SFTP | gebruikersnaam + wachtwoord | Bij elke back-up |
| GitHub → Render | HTTPS (Git clone) | automatisch via Render-token | Bij elke git push |
| Apps Script → Google Drive | interne API | Apps Script-account | Dagelijks |

### 9.5 Beveiliging en beperkingen

\- MonsterASP-SFTP-gegevens worden bewaard als Environment Variables in Render (SFTP_USER, SFTP_PASS).  
\- GitHub bevat geen gevoelige data.  
\- Render Free Plan gaat in slaapstand na 15 minuten inactiviteit, maar wakeUpRender voorkomt dat.  
\- Apps Script heeft ruime limieten voor triggers (max. 90/dag).  
\- Nieuwe deployment is eenvoudig via git push.  

### 9.6 Samenvatting

GitHub levert de code → Render voert ze uit in de cloud → Google Apps Script bestuurt en automatiseert het geheel.  
Alles samen vormt een robuuste, volledig automatische back-upketen zonder servers of handmatige ingrepen.
