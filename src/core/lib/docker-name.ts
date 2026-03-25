export function toDockerName(projectName: string): string {
    const slug = projectName
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+|[._-]+$/g, "");

    return `totopo-managed-${slug || "workspace"}`;
}
