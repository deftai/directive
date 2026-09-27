import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryDefaultSurfaces } from "./inventory.js";

describe("inventoryDefaultSurfaces (#4545)", () => {
  it("finds exported actions and app pages under a fixture root", () => {
    const root = mkdtempSync(join(tmpdir(), "osl-inv-"));
    const actionsDir = join(root, "app", "vehicles", "actions");
    mkdirSync(actionsDir, { recursive: true });
    writeFileSync(
      join(actionsDir, "actions.ts"),
      [
        "export async function addVehicleAction() {}",
        "export async function deleteVehicleAction() {}",
        "export const updateMileageAction = async () => {}",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(root, "app", "vehicles", "new"), { recursive: true });
    writeFileSync(
      join(root, "app", "vehicles", "new", "page.tsx"),
      "export default function Page() {}",
      "utf8",
    );

    const surfaces = inventoryDefaultSurfaces(root);
    const ids = surfaces.map((s) => `${s.kind}:${s.id}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        "server-action:addVehicleAction",
        "server-action:deleteVehicleAction",
        "server-action:updateMileageAction",
        "page:/vehicles/new",
      ]),
    );
  });

  it("returns empty when the root has no app/actions surfaces", () => {
    const root = mkdtempSync(join(tmpdir(), "osl-inv-empty-"));
    expect(inventoryDefaultSurfaces(root)).toEqual([]);
  });
});
