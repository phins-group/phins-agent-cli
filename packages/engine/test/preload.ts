import path from "path"

process.env.PHINS_DB = ":memory:"
process.env.PHINS_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.PHINS_DISABLE_MODELS_FETCH = "true"
