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

const keyProbe = probe<HTMLInputElement>("#key-probe")
const keyLog = probe<HTMLParagraphElement>("#key-log")
keyProbe.addEventListener("keydown", event => {
  const modifiers = [
    event.ctrlKey ? "ctrl" : "",
    event.shiftKey ? "shift" : "",
    event.altKey ? "alt" : "",
    event.metaKey ? "meta" : ""
  ].filter(Boolean)
  keyLog.textContent = [...modifiers, event.key].join("+")
})

// Read the FileList back out of the input so a test can assert the page saw
// real File objects — names and sizes — rather than a lookalike shape.
const describeFiles = (input: HTMLInputElement): string => {
  const files = Array.from(input.files ?? [])
  if (files.length === 0) return "none"
  return files.map(file => `${file.name}:${file.size}`).join(",")
}
const upload = probe<HTMLInputElement>("#upload")
const uploadLog = probe<HTMLParagraphElement>("#upload-log")
upload.addEventListener("change", () => {
  uploadLog.textContent = describeFiles(upload)
})
const uploads = probe<HTMLInputElement>("#uploads")
const uploadsLog = probe<HTMLParagraphElement>("#uploads-log")
uploads.addEventListener("change", () => {
  uploadsLog.textContent = describeFiles(uploads)
})

const wheelLog = probe<HTMLParagraphElement>("#wheel-log")
let wheelEvents = 0
const sizeScroller = (id: string, innerId: string): HTMLDivElement => {
  probe<HTMLDivElement>(innerId).style.height = "800px"
  const box = probe<HTMLDivElement>(id)
  box.style.height = "60px"
  box.style.overflow = "auto"
  box.addEventListener("wheel", () => {
    wheelEvents += 1
    wheelLog.textContent = String(wheelEvents)
  })
  return box
}
sizeScroller("#wheel-scroller", "#wheel-inner")
// Cancels the wheel, so the event is observed but the scroll must not happen —
// the pair is what separates "listener ran" from "scrollport moved".
sizeScroller("#wheel-blocked", "#wheel-blocked-inner").addEventListener("wheel", event => {
  event.preventDefault()
})

const dialogAnswer = probe<HTMLParagraphElement>("#dialog-answer")
probe<HTMLButtonElement>("#ask-confirm").addEventListener("click", () => {
  dialogAnswer.textContent = `confirm:${window.confirm("Delete the record?")}`
})
probe<HTMLButtonElement>("#ask-prompt").addEventListener("click", () => {
  dialogAnswer.textContent = `prompt:${window.prompt("New name?", "untitled")}`
})
probe<HTMLButtonElement>("#ask-alert").addEventListener("click", () => {
  window.alert("Record saved")
  // Reached only if the alert returned, which is the point: an unintercepted
  // alert blocks here forever.
  dialogAnswer.textContent = "alert:returned"
})

console.warn("fixture warning marker")

for (let index = 1; index <= 80; index += 1) {
  const article = document.createElement("article")
  article.dataset.turn = String(index)
  const lines = Array.from({ length: (index % 7) + 1 }, (_, line) => `Turn ${index}, line ${line + 1}`)
  article.textContent = lines.join("\n")
  turns.append(article)
}

document.documentElement.dataset.hasgardReady = "true"
