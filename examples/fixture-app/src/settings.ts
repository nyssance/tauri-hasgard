const theme = document.querySelector<HTMLSelectElement>("#theme")
const apply = document.querySelector<HTMLButtonElement>("#apply")
const status = document.querySelector<HTMLOutputElement>("#settings-status")

if (!theme || !apply || !status) throw new Error("Settings fixture DOM is incomplete")

apply.addEventListener("click", () => {
  status.value = `Applied ${theme.value}`
})

document.documentElement.dataset.hasgardReady = "true"
