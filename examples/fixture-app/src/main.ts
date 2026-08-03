import { invoke } from "@tauri-apps/api/core"

const displayName = document.querySelector<HTMLInputElement>("#display-name")
const save = document.querySelector<HTMLButtonElement>("#save")
const status = document.querySelector<HTMLOutputElement>("#status")
const openDialog = document.querySelector<HTMLButtonElement>("#open-dialog")
const closeDialog = document.querySelector<HTMLButtonElement>("#close-dialog")
const dialog = document.querySelector<HTMLDialogElement>("#confirm-dialog")
const openSettings = document.querySelector<HTMLButtonElement>("#open-settings")
const turns = document.querySelector<HTMLElement>("#turns")

if (!displayName || !save || !status || !openDialog || !closeDialog || !dialog || !openSettings || !turns) {
  throw new Error("Fixture DOM is incomplete")
}

save.addEventListener("click", () => {
  status.value = `Saved ${displayName.value}`
})
openDialog.addEventListener("click", () => dialog.showModal())
closeDialog.addEventListener("click", () => dialog.close())
openSettings.addEventListener("click", async () => invoke("open_settings"))

for (let index = 1; index <= 80; index += 1) {
  const article = document.createElement("article")
  article.dataset.turn = String(index)
  const lines = Array.from({ length: (index % 7) + 1 }, (_, line) => `Turn ${index}, line ${line + 1}`)
  article.textContent = lines.join("\n")
  turns.append(article)
}

document.documentElement.dataset.hasgardReady = "true"
