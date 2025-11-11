/*************************************************************
 *  MONSTERASP BACKUP VIA RENDER + GOOGLE DRIVE (EENVOUDIG + WAKEUP)
 *************************************************************/
function getMonsterBackup() {
  // 👋 Render eerst wakker maken
  wakeUpRender();
  Utilities.sleep(10000); // wacht 10s zodat Render kan opstarten

  const metaUrl = "https://monsterasp-sftp-bridge-i7as.onrender.com/meta";
  const runUrl  = "https://monsterasp-sftp-bridge-i7as.onrender.com/run";

  try {
    Logger.log("Ophalen metadata...");
    const metaResp = UrlFetchApp.fetch(metaUrl);
    const meta = JSON.parse(metaResp.getContentText());
    const backupDate = new Date(meta.modified);
    const datumString = Utilities.formatDate(backupDate, Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
    const filename = meta.filename.replace(".zpaq", `_${datumString}.zpaq`);

    Logger.log("Download uitvoeren...");
    const resp = UrlFetchApp.fetch(runUrl);
    if (resp.getResponseCode() !== 200) throw new Error("Download mislukt");

    const blob = resp.getBlob();
    const folder = getOrCreateFolder("MonsterASP-Backups");
    const file = folder.createFile(blob).setName(filename);
    const deletedCount = cleanupOldBackups(folder);

    const log =
      `✅ MONSTERASP BACK-UP GESLAAGD\n\n` +
      `Datum: ${datumString}\n` +
      `Bestandsnaam: ${filename}\n` +
      `Drive-map: ${folder.getName()}\n` +
      `Verwijderde oude back-ups: ${deletedCount}\n\n` +
      `De back-up werd opgeslagen op Google Drive.\n` +
      `(Link niet in e-mail opgenomen: ${file.getUrl()})\n`;

    const logBlob = Utilities.newBlob(log, "text/plain", `backup_log_${datumString}.txt`);
    MailApp.sendEmail({
      to: "debrouweryvan@gmail.com",
      subject: `✅ MonsterASP Back-up geslaagd – ${datumString}`,
      body: "De back-up werd succesvol uitgevoerd. Zie logbestand in bijlage.",
      attachments: [logBlob]
    });

    Logger.log("✅ Back-up voltooid zonder Drive-link in e-mail.");
  } catch (err) {
    const body =
      `❌ MONSTERASP BACK-UP MISLUKT\n\n` +
      `Foutmelding: ${err.message}\n\nControleer Render of de verbinding.`;
    MailApp.sendEmail({
      to: "debrouweryvan@gmail.com",
      subject: "❌ MonsterASP Back-up mislukt",
      body: body
    });
    Logger.log("❌ Fout: " + err.message);
  }
}

/*************************************************************
 *  HULPFUNCTIES
 *************************************************************/
function cleanupOldBackups(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  let deletedCount = 0;
  for (let i = 3; i < files.length; i++) {
    files[i].setTrashed(true);
    deletedCount++;
  }
  return deletedCount;
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(name);
}

/*************************************************************
 *  WAKEUP FUNCTIE
 *************************************************************/
function wakeUpRender() {
  const url = "https://monsterasp-sftp-bridge-i7as.onrender.com/"; // juiste domein
  try {
    const start = new Date().getTime();
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const ms = new Date().getTime() - start;
    Logger.log(`Ping uitgevoerd – Status: ${resp.getResponseCode()} – Reactietijd: ${ms} ms`);
  } catch (e) {
    Logger.log("Ping mislukt: " + e.message);
  }
}
