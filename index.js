import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 10000;
const BACKUP_DIR = "/tmp/backups";
const LOG_PATH = "/tmp/bridge.log";

// ---------------------------
// LOGFUNCTIE
// ---------------------------
function logLine(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, text);
  } catch {}
}

// ---------------------------
// ALGEMENE INSTELLINGEN
// ---------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  next();
});

// Endpoint om logs te bekijken
app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-8000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge actief"));

// ---------------------------
// /run – download + upload naar Google Drive
// ---------------------------
app.get("/run", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logLine("===== /run gestart =====");

    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    let files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    // Sorteren op laatste wijziging
    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    const remoteFile = `${remoteDir}/${latest.name}`;
    const localPath = path.join(BACKUP_DIR, latest.name);

    logLine("Start download: " + remoteFile);
    await sftp.fastGet(remoteFile, localPath, {
      concurrency: 1,
      chunkSize: 4 * 1024 * 1024,
      step: (transferred, chunk, total) => {
        if (transferred % (10 * 1024 * 1024) < 4 * 1024 * 1024) {
          logLine(`Progress: ${transferred}/${total} bytes`);
        }
      },
    });
    await sftp.end();

    const stats = fs.statSync(localPath);
    logLine(`✔ Download klaar (${stats.size} bytes)`);

    // SHA1 berekenen
    const fileBuffer = fs.readFileSync(localPath);
    const sha1 = crypto.createHash("sha1").update(fileBuffer).digest("hex");
    logLine(`SHA1: ${sha1}`);

    // ---------------------------
    // Upload naar Google Drive
    // ---------------------------
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    const drive = google.drive({ version: "v3", auth });

    const fileMetadata = {
      name: latest.name,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    };

    const media = {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(localPath),
    };

    logLine("Upload naar Google Drive gestart...");
    const driveResp = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, webViewLink, name",
    });

    const fileId = driveResp.data.id;
    const fileUrl = driveResp.data.webViewLink;
    logLine(`✔ Upload voltooid: ${fileUrl}`);

    // Resultaat terugsturen
    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: stats.size,
      sha1: sha1,
      driveFileId: fileId,
      driveUrl: fileUrl,
    });
  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// SERVER START
// ---------------------------
app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
