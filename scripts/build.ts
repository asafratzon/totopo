import { execSync } from "node:child_process";
import { outro } from "@clack/prompts";

try {
    execSync("tsc -p tsconfig.build.json", { stdio: "pipe" });
    outro("Build complete.");
} catch (err) {
    const output =
        err instanceof Error && "stderr" in err ? String((err as NodeJS.ErrnoException & { stderr: Buffer }).stderr) : String(err);
    outro("Build failed.");
    process.stderr.write(output);
    process.exit(1);
}
