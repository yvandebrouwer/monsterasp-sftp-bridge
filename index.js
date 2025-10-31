import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;

// 🔹 Sta toe dat de X-Backup-Date header wordt meegegeven
app.use((req, res, next) => {
  res.setHeader("Access-Control-Expose-Headers", "X-Backup-Date");
  next();
});

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge OK"));

// JSON endpoint (controle)
app.get("/check", async (req, res) => {
  res.json({ status: "OK", message: "Bridge werkt" });
});

// download endpoint
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

    // 🔹 Sorteer op wijzigingsdatum (nieuwste eerst)
    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    const localPath = path.join(localDir, latest.name);

    // 🔹 Download bestand
    await sftp.fastGet(`${remoteDir}/${latest.name}`, localPath);
    await sftp.end();

    // 🔹 Zet de originele bestandsdatum mee in de headers
    res.setHeader("X-Backup-Date", new Date(latest.modifyTime).toISOString());
    res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    // 🔹 Stuur het bestand als stream terug naar de client (Apps Script)
    const fileStream = fs.createReadStream(localPath);
    fileStream.pipe(res);
  } catch (err) {
    console.error("Fout:", err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
