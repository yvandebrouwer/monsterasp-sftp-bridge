import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import stream from "stream";

const app = express();
const PORT = process.env.PORT || 10000;

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
// VEILIGE DOWNLOAD MET CHECKSUM
// ---------------------------
async function safeDownloadWithChecksum(sftp, remoteFile, localPath, expectedSize) {
  return new Promise(async (resolve, reject) => {
    try {
      const readStream = await sftp.get(remoteFile);
      const hash = crypto.createHash("sha1");
      const pass = new stream.PassThrough();
      const writeStream = fs.createWriteStream(localPath);

      let bytes = 0;
      readStream
        .on("data", chunk => {
          bytes += chunk.length;
          hash.update(chunk);
          pass.write(chunk);
        })
        .on("end", () => pass.end())
        .on("error", err => reject(err));

      pass.pipe(writeStream);

      writeStream.on("finish", () => {
        const digest = hash.digest("hex");
        const stats = fs.statSync(localPath);

        if (stats.size !== expectedSize) {
          reject(new Error(`Incomplete download: lokaal ${stats.size} van ${expectedSize} bytes`));
        } else {
          console.log(`✔ Download volledig (${stats.size} bytes)`);
          console.log(`✔ SHA1: ${digest}`);
          resolve(digest);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------
// /check
// ---------------------------
app.get("/check", (req, res) => {
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

    res.json({
      status: "OK",
      filename: latest.name,
      sizeBytes: latest.size,
      modified: new Date(latest.realMtime * 1000).toISOString(),
      message: "Laatste backup-info succesvol opgehaald"
    });
  } catch (err) {
    console.error("Fout bij /meta:", err.message);
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

    const list = files.map(f => ({
      filename: f.name,
      sizeBytes: f.size,
      modified: new Date(f.realMtime * 1000).toISOString()
    }));

    res.json({ status: "OK", count: list.length, files: list });
  } catch (err) {
    console.error("Fout bij /list:", err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

// ---------------------------
// /run
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

    let files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    files = await enrichWithRealMtime(sftp, remoteDir, files);
    files.sort((a, b) => b.realMtime - a.realMtime);
    const latest = files[0];
    const localPath = path.join(localDir, latest.name);
    const remoteFile = `${remoteDir}/${latest.name}`;

    console.log("Start download:", remoteFile);

    await safeDownloadWithChecksum(sftp, remoteFile, localPath, latest.size);
    await sftp.end();

    const backupDateIso = new Date(latest.realMtime * 1000).toISOString();
    console.log("Backupdatum:", backupDateIso);

    res.setHeader("X-Backup-Date", backupDateIso);
    res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
    res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Backup-Meta", JSON.stringify({
      filename: latest.name,
      modified: backupDateIso,
      sizeBytes: latest.size
    }));

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
