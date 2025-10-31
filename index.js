// index.js
import express from "express";
import Client from "ssh2-sftp-client";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("✅ MonsterASP SFTP Bridge OK"));

app.all("/run", async (req, res) => {
  const sftp = new Client();
  const remoteDir = "/";
  const localDir = "/tmp/backups";

  try {
    // Lokale map aanmaken
    fs.mkdirSync(localDir, { recursive: true });

    // Verbinding maken met MonsterASP via SFTP
    await sftp.connect({
      host: "bh2.siteasp.net",
      port: 22,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASS,
    });

    // Lijst van .zpaq-bestanden ophalen
    const files = (await sftp.list(remoteDir)).filter(f => f.name.endsWith(".zpaq"));
    if (!files.length) throw new Error("Geen .zpaq-bestanden gevonden");

    // Nieuwste bestand bepalen (meest recent gewijzigd)
    files.sort((a, b) => b.modifyTime - a.modifyTime);
    const latest = files[0];
    const localPath = path.join(localDir, latest.name);

    // Download het bestand
    await sftp.fastGet(`${remoteDir}/${latest.name}`, localPath);
    await sftp.end();

    res.json({
      status: "OK",
      file: latest.name,
      message: `Bestand ${latest.name} succesvol opgehaald.`,
    });
  } catch (err) {
    console.error("Fout:", err.message);
    res.status(500).json({ status: "Error", error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

