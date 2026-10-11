import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

export class HardwareService {
  constructor({
    hwmonDir = "/sys/class/hwmon",
    thermalDir = "/sys/class/thermal",
    powerSupplyDir = "/sys/class/power_supply",
  } = {}) {
    this.hwmonDir = hwmonDir;
    this.thermalDir = thermalDir;
    this.powerSupplyDir = powerSupplyDir;
    this.previousCpuTimes = null;
    this.lastSampleAt = 0;
    this.cachedUsage = 0;
  }

  // Mesure du taux d'usage CPU réel entre deux lectures
  getCpuUsage() {
    const cpus = os.cpus();
    if (!cpus || !cpus.length) return 0;
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type of Object.keys(cpu.times)) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }

    const now = Date.now();
    if (this.previousCpuTimes && now - this.lastSampleAt >= 500) {
      const deltaIdle = totalIdle - this.previousCpuTimes.idle;
      const deltaTotal = totalTick - this.previousCpuTimes.total;
      if (deltaTotal > 0) {
        this.cachedUsage = Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 100)));
      }
    }
    this.previousCpuTimes = { idle: totalIdle, total: totalTick };
    this.lastSampleAt = now;
    return this.cachedUsage;
  }

  async read() {
    let cpuTemp = null;
    let packageTemp = null;
    let dellCpuTemp = null;
    let amdCpuTemp = null;
    const coreTemps = [];
    let skinTemp = null;
    let ssdTemp = null;
    let ramTemp = null;
    let fanRpm = null;
    const sensors = [];

    // 1. Exploration hwmon (coretemp, dell_ddv, nvme, etc.)
    try {
      const entries = await fs.readdir(this.hwmonDir).catch(() => []);
      for (const entry of entries) {
        const dir = path.join(this.hwmonDir, entry);
        let chipName = "";
        try {
          chipName = (await fs.readFile(path.join(dir, "name"), "utf8")).trim();
        } catch {}

        let files = [];
        try {
          files = await fs.readdir(dir);
        } catch {
          continue;
        }

        // Températures
        const tempInputs = files.filter((f) => f.startsWith("temp") && f.endsWith("_input"));
        for (const tf of tempInputs) {
          const base = tf.replace("_input", "");
          let label = base;
          try {
            label = (await fs.readFile(path.join(dir, `${base}_label`), "utf8")).trim();
          } catch {}

          try {
            const raw = parseInt((await fs.readFile(path.join(dir, tf), "utf8")).trim(), 10);
            if (!isNaN(raw) && raw > 0 && raw < 140000) {
              const deg = Math.round(raw / 1000);
              sensors.push({ chip: chipName, label, deg });

              // Détection CPU
              if (chipName === "coretemp" && /package/i.test(label)) {
                if (packageTemp === null || deg > packageTemp) packageTemp = deg;
              } else if (chipName === "coretemp" && /^core/i.test(label)) {
                coreTemps.push(deg);
              } else if ((chipName === "dell_ddv" || chipName === "dell_smm") && /^cpu/i.test(label)) {
                if (dellCpuTemp === null || deg > dellCpuTemp) dellCpuTemp = deg;
              } else if ((chipName === "k10temp" || chipName === "zenpower") && /tctl|tdie/i.test(label)) {
                if (amdCpuTemp === null || deg > amdCpuTemp) amdCpuTemp = deg;
              }

              // Détection Coque / Skin / Ambiant
              if (
                ((chipName === "dell_ddv" || chipName === "dell_smm") && /ambient|skin/i.test(label)) ||
                /ambient|skin/i.test(label)
              ) {
                if (skinTemp === null || deg > skinTemp) skinTemp = deg;
              }

              // Détection SSD
              if (chipName === "nvme" && ssdTemp === null) {
                ssdTemp = deg;
              }

              // Détection RAM (SODIMM)
              if (/sodimm|ddr|ram/i.test(label) && ramTemp === null) {
                ramTemp = deg;
              }
            }
          } catch {}
        }

        // Ventilateurs
        const fanInputs = files.filter((f) => f.startsWith("fan") && f.endsWith("_input"));
        for (const ff of fanInputs) {
          try {
            const rpm = parseInt((await fs.readFile(path.join(dir, ff), "utf8")).trim(), 10);
            if (!isNaN(rpm) && rpm >= 0) {
              if (fanRpm === null || rpm > fanRpm) fanRpm = rpm;
            }
          } catch {}
        }
      }
    } catch {}

    // Priorisation des sondes physiques CPU fiables
    if (packageTemp !== null) {
      cpuTemp = packageTemp;
    } else if (dellCpuTemp !== null) {
      cpuTemp = dellCpuTemp;
    } else if (amdCpuTemp !== null) {
      cpuTemp = amdCpuTemp;
    } else if (coreTemps.length > 0) {
      cpuTemp = Math.round(coreTemps.reduce((a, b) => a + b, 0) / coreTemps.length);
    }

    // 2. Exploration thermal zones (/sys/class/thermal/thermal_zone*)
    try {
      const zones = (await fs.readdir(this.thermalDir).catch(() => [])).filter((f) => f.startsWith("thermal_zone"));
      for (const z of zones) {
        const dir = path.join(this.thermalDir, z);
        try {
          const type = (await fs.readFile(path.join(dir, "type"), "utf8")).trim();
          const raw = parseInt((await fs.readFile(path.join(dir, "temp"), "utf8")).trim(), 10);
          if (!isNaN(raw) && raw > 0 && raw < 140000) {
            const deg = Math.round(raw / 1000);
            sensors.push({ chip: "thermal", label: type, deg });

            // Ne jamais écraser une sonde CPU matérielle fiable par une zone ACPI virtuelle
            if (cpuTemp === null && /^(?:cpu|tcpu)$/i.test(type)) {
              cpuTemp = deg;
            }
            if (skinTemp === null || (/tskn|skin|surface/i.test(type) && deg > skinTemp)) {
              skinTemp = deg;
            }
            if (ramTemp === null && /tmem/i.test(type)) {
              ramTemp = deg;
            }
            if (ssdTemp === null && /ngff/i.test(type)) {
              ssdTemp = deg;
            }
          }
        } catch {}
      }
    } catch {}

    // Si pas de sonde skin spécifique trouvée mais une sonde de température ambiante existe
    if (skinTemp === null && cpuTemp !== null) {
      // Si aucune sonde de coque n'est exposée sur la machine, estimation dérivée ou null
      skinTemp = null;
    }

    // 3. Batterie
    let battery = null;
    try {
      const batDir = path.join(this.powerSupplyDir, "BAT0");
      const capacity = parseInt((await fs.readFile(path.join(batDir, "capacity"), "utf8")).trim(), 10);
      const status = (await fs.readFile(path.join(batDir, "status"), "utf8")).trim();
      if (!isNaN(capacity)) {
        battery = { percent: capacity, status };
      }
    } catch {}

    // 4. Système (Charge, RAM, Cores)
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg().map((val) => Math.round(val * 10) / 10);
    const cpuUsage = this.getCpuUsage();
    const cpus = os.cpus() || [];

    // Détermination de l'état thermique global
    const maxTemp = Math.max(cpuTemp || 0, (skinTemp || 0) + 15);
    let state = "normal"; // normal | warm | hot
    let alertLabel = "Température normale";

    if (cpuTemp >= 82 || (skinTemp && skinTemp >= 68)) {
      state = "hot";
      alertLabel = cpuTemp >= 90 ? "Surchauffe détectée" : "Température élevée";
    } else if (cpuTemp >= 68 || (skinTemp && skinTemp >= 52)) {
      state = "warm";
      alertLabel = "En charge / tiède";
    }

    return {
      cpuTemp,
      skinTemp,
      ssdTemp,
      ramTemp,
      fanRpm,
      state,
      alertLabel,
      cpu: {
        model: cpus[0]?.model || "CPU",
        cores: cpus.length,
        usagePercent: cpuUsage,
        loadAvg,
      },
      memory: {
        totalMb: Math.round(totalMem / (1024 * 1024)),
        usedMb: Math.round(usedMem / (1024 * 1024)),
        percent: Math.round((usedMem / totalMem) * 100),
      },
      battery,
      sensors,
      timestamp: Date.now(),
    };
  }
}
