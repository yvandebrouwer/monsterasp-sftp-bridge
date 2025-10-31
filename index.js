import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------
// ALGEMENE INSTELLINGEN
// ---------------------------

// Zorg dat custom headers (zoals X-Backup-Date) beschikbaar blijven
app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge OK"));

// ---------------------------
// /check  -> eenvoudige statuscontrole
// ---------------------------
app.get("/check", async (req, res) => {
  res.json({ status: "OK", message: "Bridge werkt correct" });
});

// ---------------------------
// /meta  -> alleen metadata (geen download)
// ---------------------------
app.get("/meta", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";

  try {
    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    const files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    // Sorteer op wijzigingsdatum (nieuwste eerst)
    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    await sftp.end();

    // Geef metadata terug in JSON
    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: latest.size,
      modified: new Date(latest.modifyTime).toISOString(),
      message: "Laatste backup-info succesvol opgehaald"
    });
  } catch (err) {
    console.error("Fout bij /meta:", err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// /run  -> download van laatste backup
// ---------------------------
app.get("/run", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";
  const localDir = "/tmp/backups";

  try {
    fs.mkdirSync(localDir, { recursive: true });

    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    const files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    const localPath = path.join(localDir, latest.name);

    // Download bestand
    await sftp.fastGet(`${remoteDir}/${latest.name}`, localPath);
    await sftp.end();

    const backupDateIso = new Date(latest.modifyTime).toISOString();
    console.log("Backupdatum:", backupDateIso);

    // Voeg de originele datum mee in de headers
    res.setHeader("X-Backup-Date", backupDateIso);
    res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
    res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    // Extra JSON-header (voor debugging of clients die headers niet lezen)
    res.setHeader("X-Backup-Meta", JSON.stringify({
      filename: latest.name,
      modified: backupDateIso,
      sizeBytes: latest.size
    }));

    // Stream het bestand
    const fileStream = fs.createReadStream(localPath);
    fileStream.pipe(res);

  } catch (err) {
    console.error("Fout:", err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// SERVER STARTEN
// ---------------------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
