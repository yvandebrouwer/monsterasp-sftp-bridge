import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;
const LOG_PATH = "/tmp/bridge.log";
const BACKUP_DIR = "/tmp/backups";

// ---------------------------
// LOGFUNCTIE
// ---------------------------
function logLine(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, text); } catch {}
}

// endpoint om logs te lezen
app.get("/logs", (req, res) => {
  try {
    const data = fs.readFileSync(LOG_PATH, "utf8");
    res.type("text/plain").send(data.slice(-8000));
  } catch {
    res.type("text/plain").send("Nog geen logbestand of geen schrijfrechten.");
  }
});

// maakt bestanden direct bereikbaar
app.use("/files", express.static(BACKUP_DIR));

// ---------------------------
// ALGEMEEN
// ---------------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  next();
});

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge OK"));

// hulpfunctie voor mtime
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

    logLine(`/meta: laatste bestand ${latest.name}`);

    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: latest.size,
      modified: new Date(latest.realMtime * 1000).toISOString()
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

    res.json({
      status: "OK",
      count: files.length,
      files: files.map(f => ({
        filename: f.name,
        sizeBytes: f.size,
        modified: new Date(f.realMtime * 1000).toISOString()
      }))
    });
  } catch (err) {
    logLine("❌ Fout bij /list: " + err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// /run
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

    files = await enrichWithRealMtime(sftp, remoteDir, files);
    files.sort((a, b) => b.realMtime - a.realMtime);
    const latest = files[0];
    const remoteFile = `${remoteDir}/${latest.name}`;
    const localPath = path.join(BACKUP_DIR, latest.name);

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

    const backupDateIso = new Date().toISOString(); // gebruik nu, niet foutieve serverdatum
    const downloadUrl = `https://monsterasp-sftp-bridge.onrender.com/files/${latest.name}`;

    logLine(`Klaar. Bestand beschikbaar via: ${downloadUrl}`);

    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: latest.size,
      modified: backupDateIso,
      sha1: sha1,
      downloadUrl: downloadUrl
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
