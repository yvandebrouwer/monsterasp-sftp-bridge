import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;
const LOG_PATH = "/tmp/bridge.log";

// ---------------------------
// LOGFUNCTIE – schrijft naar console én bestand
// ---------------------------
function logLine(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, text);
  } catch {}
}

// Endpoint om logs te lezen
app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-8000)); // laatste 8000 tekens
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

// ---------------------------
// ALGEMENE INSTELLINGEN
// ---------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge OK"));

// ---------------------------
// Functie om echte mtime op te halen via sftp.stat()
// ---------------------------
async function enrichWithRealMtime(sftp, remoteDir, files) {
  const result = [];
  for (const f of files) {
    try {
      const st = await sftp.stat(`${remoteDir}/${f.name}`);
      f.realMtime = st.modifyTime || st.mtime || 0;
    } catch {
      f.realMtime = 0;
    }
    result.push(f);
  }
  return result;
}

// ---------------------------
// /check
// ---------------------------
app.get("/check", (req, res) => {
  logLine("/check aangeroepen");
  res.json({ status: "OK", message: "Bridge werkt correct" });
});

// ---------------------------
// /meta
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

    let files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files = await enrichWithRealMtime(sftp, remoteDir, files);
    files.sort((a, b) => b.realMtime - a.realMtime);
    const latest = files[0];
    await sftp.end();

    logLine(`/meta: laatste bestand ${latest.name} (${latest.size} bytes)`);

    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: latest.size,
      modified: new Date(latest.realMtime * 1000).toISOString(),
      message: "Laatste backup-info succesvol opgehaald"
    });
  } catch (err) {
    logLine("❌ Fout bij /meta: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// /list
// ---------------------------
app.get("/list", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";
  try {
    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    let files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files = await enrichWithRealMtime(sftp, remoteDir, files);
    files.sort((a, b) => b.realMtime - a.realMtime);
    await sftp.end();

    logLine(`/list: ${files.length} bestanden gevonden`);

    const list = files.map(f => ({
      filename: f.name,
      sizeBytes: f.size,
      modified: new Date(f.realMtime * 1000).toISOString()
    }));

    res.json({ status: "OK", count: list.length, files: list });
  } catch (err) {
    logLine("❌ Fout bij /list: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// /run  (met logging + fastGet + checksum)
// ---------------------------
app.get("/run", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";
  const localDir = "/tmp/backups";

  try {
    fs.mkdirSync(localDir, { recursive: true });
    logLine("===== /run gestart =====");

    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    let files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files = await enrichWithRealMtime(sftp, remoteDir, files);
    files.sort((a, b) => b.realMtime - a.realMtime);
    const latest = files[0];
    const localPath = path.join(localDir, latest.name);
    const remoteFile = `${remoteDir}/${latest.name}`;

    logLine("Start download: " + remoteFile);

    const remoteStat = await sftp.stat(remoteFile);
    logLine("Remote size: " + remoteStat.size);

    await sftp.fastGet(remoteFile, localPath, {
      concurrency: 1,
      chunkSize: 4 * 1024 * 1024,
      step: (transferred, chunk, total) => {
        if (transferred % (10 * 1024 * 1024) < 4 * 1024 * 1024) {
          logLine(`Progress: ${transferred}/${total} bytes`);
        }
      }
    });

    const localStat = fs.statSync(localPath);
    logLine("Local size: " + localStat.size);

    if (localStat.size !== remoteStat.size) {
      throw new Error(`Incomplete download: lokaal ${localStat.size} van ${remoteStat.size} bytes`);
    }

    const fileBuffer = fs.readFileSync(localPath);
    const sha1 = crypto.createHash("sha1").update(fileBuffer).digest("hex");
    logLine("✔ Download volledig, SHA1=" + sha1);

    await sftp.end();

    const backupDateIso = new Date(latest.realMtime * 1000).toISOString();
    logLine("Backupdatum: " + backupDateIso);

    res.setHeader("X-Backup-Date", backupDateIso);
    res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
    res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Backup-Meta", JSON.stringify({
      filename: latest.name,
      modified: backupDateIso,
      sizeBytes: latest.size,
      sha1: sha1
    }));

    const fileStream = fs.createReadStream(localPath);
    fileStream.pipe(res);
  } catch (err) {
    logLine("❌ Fout in /run: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// SERVER STARTEN
// ---------------------------
app.listen(PORT, () => logLine(`Server running on port ${PORT}`));
