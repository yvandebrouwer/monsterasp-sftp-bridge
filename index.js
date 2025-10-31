import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;

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

    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    const localPath = path.join(localDir, latest.name);

    // Download naar lokale map
    await sftp.fastGet(`${remoteDir}/${latest.name}`, localPath);
    await sftp.end();

    // Stuur het bestand zelf terug aan de client (Apps Script)
    res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    const fileStream = fs.createReadStream(localPath);
    fileStream.pipe(res);
  } catch (err) {
    console.error("Fout:", err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
