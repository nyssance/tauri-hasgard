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

const probe = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(id)
  if (!found) throw new Error(`Fixture DOM is incomplete: ${id}`)
  return found
}

const hoverTarget = probe<HTMLDivElement>("#hover-target")
const hoverState = probe<HTMLParagraphElement>("#hover-state")
hoverTarget.addEventListener("mouseover", () => {
  hoverState.textContent = "hovered"
})

const dblTarget = probe<HTMLDivElement>("#dbl-target")
const dblCount = probe<HTMLParagraphElement>("#dbl-count")
let doubleClicks = 0
dblTarget.addEventListener("dblclick", () => {
  doubleClicks += 1
  dblCount.textContent = String(doubleClicks)
})

const focusState = probe<HTMLParagraphElement>("#focus-state")
const searchInput = probe<HTMLInputElement>("#search")
searchInput.addEventListener("focus", () => {
  focusState.textContent = "focused"
})
searchInput.addEventListener("blur", () => {
  focusState.textContent = "blurred"
})

// Flips with no DOM mutation observable in advance, so only a polling wait
// catches it — a MutationObserver-only wait would sit here until it timed out.
window.setTimeout(() => {
  probe<HTMLParagraphElement>("#delayed").textContent = "ready"
}, 400)

const scrollerInner = probe<HTMLDivElement>("#scroller-inner")
scrollerInner.style.height = "800px"
const scroller = probe<HTMLDivElement>("#scroller")
scroller.style.height = "60px"
scroller.style.overflow = "auto"

console.warn("fixture warning marker")

for (let index = 1; index <= 80; index += 1) {
  const article = document.createElement("article")
  article.dataset.turn = String(index)
  const lines = Array.from({ length: (index % 7) + 1 }, (_, line) => `Turn ${index}, line ${line + 1}`)
  article.textContent = lines.join("\n")
  turns.append(article)
}

document.documentElement.dataset.hasgardReady = "true"
