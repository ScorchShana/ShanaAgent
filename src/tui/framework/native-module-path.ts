import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeModuleCandidateOptions {
 moduleUrl?: string;
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
 const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
 return [join(moduleDir, nativePath)];
}
