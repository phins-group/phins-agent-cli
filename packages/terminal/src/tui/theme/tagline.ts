import { useKV } from "../state/kv"

const taglines = {
  vi: "TỪ Ý TƯỞNG ĐẾN CÔNG VIỆC HOÀN THÀNH",
  en: "FROM IDEAS to IMPACT",
} as const

export function useTagline() {
  const kv = useKV()
  const language = () => kv.get("tagline_language") === "en" ? "en" : "vi"
  return {
    language,
    text: () => taglines[language()],
    set: (value: keyof typeof taglines) => kv.set("tagline_language", value),
  }
}
