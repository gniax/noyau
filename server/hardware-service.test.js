import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HardwareService } from "./hardware-service.js";

test("HardwareService lit les capteurs simulés hwmon et thermal zones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-hw-test-"));
  const hwmonDir = path.join(root, "hwmon");
  const thermalDir = path.join(root, "thermal");
  const powerSupplyDir = path.join(root, "power_supply");

  // Mock coretemp
  const coretempDir = path.join(hwmonDir, "hwmon0");
  await fs.mkdir(coretempDir, { recursive: true });
  await fs.writeFile(path.join(coretempDir, "name"), "coretemp\n");
  await fs.writeFile(path.join(coretempDir, "temp1_input"), "75000\n");
  await fs.writeFile(path.join(coretempDir, "temp1_label"), "Package id 0\n");

  // Mock dell_ddv avec ventilateur et température ambiante/coque
  const dellDir = path.join(hwmonDir, "hwmon1");
  await fs.mkdir(dellDir, { recursive: true });
  await fs.writeFile(path.join(dellDir, "name"), "dell_ddv\n");
  await fs.writeFile(path.join(dellDir, "temp1_input"), "74000\n");
  await fs.writeFile(path.join(dellDir, "temp1_label"), "CPU\n");
  await fs.writeFile(path.join(dellDir, "temp2_input"), "68000\n");
  await fs.writeFile(path.join(dellDir, "temp2_label"), "Ambient\n");
  await fs.writeFile(path.join(dellDir, "fan1_input"), "3200\n");

  // Mock thermal zone TSKN
  const zoneDir = path.join(thermalDir, "thermal_zone0");
  await fs.mkdir(zoneDir, { recursive: true });
  await fs.writeFile(path.join(zoneDir, "type"), "TSKN\n");
  await fs.writeFile(path.join(zoneDir, "temp"), "69000\n");

  // Mock thermal zone x86_pkg_temp à 100°C (artefact ACPI à ignorer quand hwmon est présent)
  const zonePkgDir = path.join(thermalDir, "thermal_zone1");
  await fs.mkdir(zonePkgDir, { recursive: true });
  await fs.writeFile(path.join(zonePkgDir, "type"), "x86_pkg_temp\n");
  await fs.writeFile(path.join(zonePkgDir, "temp"), "100000\n");

  // Mock battery
  const batDir = path.join(powerSupplyDir, "BAT0");
  await fs.mkdir(batDir, { recursive: true });
  await fs.writeFile(path.join(batDir, "capacity"), "85\n");
  await fs.writeFile(path.join(batDir, "status"), "Discharging\n");

  const service = new HardwareService({ hwmonDir, thermalDir, powerSupplyDir });
  const data = await service.read();

  assert.equal(data.cpuTemp, 75);
  // La sonde skin a lu 68 depuis dell_ddv puis 69 depuis TSKN
  assert.equal(data.skinTemp, 69);
  assert.equal(data.fanRpm, 3200);
  assert.equal(data.battery.percent, 85);
  assert.equal(data.battery.status, "Discharging");
  assert.equal(data.state, "hot"); // skin >= 68 => hot
  assert.ok(data.memory.totalMb > 0);
  assert.ok(data.cpu.cores > 0);

  await fs.rm(root, { recursive: true, force: true });
});

test("HardwareService gère l'absence de sondes sans planter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noyau-hw-empty-"));
  const service = new HardwareService({
    hwmonDir: path.join(root, "hwmon"),
    thermalDir: path.join(root, "thermal"),
    powerSupplyDir: path.join(root, "power_supply"),
  });

  const data = await service.read();
  assert.equal(data.cpuTemp, null);
  assert.equal(data.skinTemp, null);
  assert.equal(data.fanRpm, null);
  assert.equal(data.battery, null);
  assert.equal(data.state, "normal");
  assert.ok(data.memory.percent >= 0);

  await fs.rm(root, { recursive: true, force: true });
});
