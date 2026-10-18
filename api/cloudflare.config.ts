import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "slotboard-api",
		compatibilityDate: "2026-10-06",
		entrypoint,
		env: {
			DB: bindings.d1({ name: "slotboard-db" }),
		},
	},
});
