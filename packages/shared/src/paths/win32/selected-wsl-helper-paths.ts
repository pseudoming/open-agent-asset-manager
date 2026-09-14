/** Recognize WSL UNC aliases before any Windows-local file operation. */
export function isAnyWslPath(filePath: string): boolean {
    return filePath.toLowerCase().startsWith("\\\\wsl.localhost\\") || filePath.toLowerCase().startsWith("\\\\wsl$\\");
}
