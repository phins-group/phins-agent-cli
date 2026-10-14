/** Preserve the existing positional, quoted and multiline argument contract. */
export function expand(template: string, argumentsText: string) {
  const args = (
    argumentsText.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []
  ).map((value) => value.replace(/^["']|["']$/g, ""))
  const positions = [...template.matchAll(/\$(\d+)/g)].map((match) =>
    Number(match[1]),
  )
  const last = Math.max(0, ...positions)
  const expanded = template
    .replaceAll(/\$(\d+)/g, (_, index: string) => {
      const position = Number(index)
      return position === last
        ? args.slice(position - 1).join(" ")
        : (args[position - 1] ?? "")
    })
    .replaceAll("$ARGUMENTS", argumentsText)
  return (
    positions.length || template.includes("$ARGUMENTS") || !argumentsText.trim()
      ? expanded
      : `${expanded}\n\n${argumentsText}`
  ).trim()
}
