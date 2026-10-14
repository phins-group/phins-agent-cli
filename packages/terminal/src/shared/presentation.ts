import { logo } from "../tui/components/wordmark"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    ...logo.map(line => `  ${line}`),
    "",
    ...(input.sessionID
      ? [
          `  ${weak("Session")}${bold}${input.title}${reset}`,
          `  ${weak("Continue")}${bold}phins resume ${input.sessionID}${reset}`,
        ]
      : []),
    `  ${weak("")}${bold}👋 Goodbye!${reset}`,
    "",
  ].join("\n")
}
