import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const projectRoot = join(import.meta.dirname, "..", "..");
const configPath = join(projectRoot, "config.yaml");
const runPath = join(projectRoot, "run.sh");
const dockerfilePath = join(projectRoot, "Dockerfile");
const packagePath = join(projectRoot, "package.json");

describe("Home Assistant add-on configuration", () => {
	it("config.yaml and Dockerfile are at repository root", () => {
		// The repository root is the add-on folder - config.yaml and Dockerfile
		// must be at the root for the Supervisor to recognize and build the add-on
		const config = readFileSync(configPath, "utf-8");
		const dockerfile = readFileSync(dockerfilePath, "utf-8");
		expect(config.length).toBeGreaterThan(0);
		expect(dockerfile.length).toBeGreaterThan(0);
		expect(configPath).toBe(join(projectRoot, "config.yaml"));
		expect(dockerfilePath).toBe(join(projectRoot, "Dockerfile"));
	});

	it("homeassistant_api is true", () => {
		const config = readFileSync(configPath, "utf-8");
		expect(config).toMatch(/homeassistant_api:\s*true/);
	});

	it("ingress is enabled for hybrid admin/guest access", () => {
		const config = readFileSync(configPath, "utf-8");
		const ingressMatch = config.match(/^ingress:\s*(.+)$/m);
		expect(ingressMatch).toBeTruthy();
		if (ingressMatch?.[1]) {
			expect(ingressMatch[1].trim()).toBe("true");
		}
		// Also verify ingress_port is set
		const ingressPortMatch = config.match(/^ingress_port:\s*(.+)$/m);
		expect(ingressPortMatch).toBeTruthy();
		if (ingressPortMatch?.[1]) {
			expect(ingressPortMatch[1].trim()).toBe("8099");
		}
	});

	it("version matches package.json", () => {
		const config = readFileSync(configPath, "utf-8");
		const pkg = JSON.parse(readFileSync(packagePath, "utf-8"));
		const versionMatch = config.match(/^version:\s*"?([^"\s]+)"?$/m);
		expect(versionMatch).toBeTruthy();
		if (versionMatch) {
			expect(versionMatch[1]).toBe(pkg.version);
		}
	});

	it("arch includes amd64", () => {
		const config = readFileSync(configPath, "utf-8");
		// Match either YAML list format (- amd64) or inline array format
		const hasAmd64 = config.match(/arch:[\s\S]*?-\s*amd64/) || config.match(/arch:\s*\[.*amd64.*\]/);
		expect(hasAmd64).toBeTruthy();
	});

	it("every key in options has matching entry in schema", () => {
		const config = readFileSync(configPath, "utf-8");

		// Extract options section
		const optionsMatch = config.match(/^options:\s*$(.*?)^(?:\w+:|$)/ms);
		expect(optionsMatch).toBeTruthy();
		if (!optionsMatch?.[1]) {
			throw new Error("Failed to match options section");
		}
		const optionsSection = optionsMatch[1];
		const optionKeys = [...optionsSection.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);

		// Extract schema section
		const schemaMatch = config.match(/^schema:\s*$(.*?)^(?:\w+:|$)/ms);
		expect(schemaMatch).toBeTruthy();
		if (!schemaMatch?.[1]) {
			throw new Error("Failed to match schema section");
		}
		const schemaSection = schemaMatch[1];
		const schemaKeys = [...schemaSection.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);

		expect(optionKeys.length).toBeGreaterThan(0);
		for (const key of optionKeys) {
			expect(schemaKeys).toContain(key);
		}
	});

	it("run.sh exists and is readable", () => {
		const script = readFileSync(runPath, "utf-8");
		expect(script.length).toBeGreaterThan(0);
	});

	it("run.sh exports all seven environment variables in add-on mode", () => {
		const script = readFileSync(runPath, "utf-8");
		expect(script).toMatch(/export\s+HA_BASE_URL/);
		expect(script).toMatch(/export\s+HA_WS_URL/);
		expect(script).toMatch(/export\s+HA_TOKEN/);
		expect(script).toMatch(/export\s+GUEST_PASSWORD/);
		expect(script).toMatch(/export\s+ADMIN_PASSWORD/);
		expect(script).toMatch(/export\s+PORT/);
		expect(script).toMatch(/export\s+DB_PATH/);
		expect(script).toMatch(/export\s+INGRESS_PORT/);
	});

	it("HA_WS_URL points at /core/websocket not /api/websocket", () => {
		const script = readFileSync(runPath, "utf-8");
		expect(script).toMatch(/HA_WS_URL.*\/core\/websocket/);
		expect(script).not.toMatch(/HA_WS_URL.*\/api\/websocket/);
	});

	it("HA_TOKEN is derived from SUPERVISOR_TOKEN", () => {
		const script = readFileSync(runPath, "utf-8");
		expect(script).toMatch(/HA_TOKEN.*SUPERVISOR_TOKEN/);
	});

	it("run.sh uses exec to start the server", () => {
		const script = readFileSync(runPath, "utf-8");
		expect(script).toMatch(/exec\s+node/);
	});

	it("Dockerfile runtime stage uses node:24-alpine", () => {
		const dockerfile = readFileSync(dockerfilePath, "utf-8");
		// Find the runtime stage (the second FROM after builder)
		// Match FROM node:24-alpine (not AS builder)
		const runtimeFromMatch = dockerfile.match(/^FROM node:24-alpine\s*$/m);
		expect(runtimeFromMatch).toBeTruthy();
	});

	it("Dockerfile has no USER directive (add-on runs as root, compose sets user)", () => {
		const dockerfile = readFileSync(dockerfilePath, "utf-8");
		// The Dockerfile should not contain a USER directive
		// Add-on runs as root; docker-compose.yml sets user: node for plain Docker
		expect(dockerfile).not.toMatch(/^USER\s+/m);
	});

	it("run.sh detects add-on mode via SUPERVISOR_TOKEN, not file presence", () => {
		const script = readFileSync(runPath, "utf-8");
		// Mode detection must key on SUPERVISOR_TOKEN (app cannot set environment)
		// not on /data/options.json presence (app can write /data in plain Docker)
		expect(script).toMatch(/if\s+\[\s+-n\s+"\$SUPERVISOR_TOKEN"\s+\]/);
		// Must not use file presence as the mode switch
		expect(script).not.toMatch(/if\s+\[\s+-f\s+\/data\/options\.json\s+\]/);
	});
});
