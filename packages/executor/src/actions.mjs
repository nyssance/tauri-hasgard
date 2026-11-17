// Page interaction only: native windows and IPC remain owned by the host.
export async function act(page, method, params) {
  const timeout = params.timeout ?? 8000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000)
    throw Error("Action timeout must be between 1 and 10000 milliseconds")
  let scope = page
  for (const frame of [].concat(params.frame ?? [])) scope = scope.frameLocator(frame)
  let locator
  let pointHandle
  let position = params.position
  if (params.actionToken) {
    const matches = []
    for (const frame of page.frames()) {
      const candidate = frame.locator(`[data-hasgard-action="${params.actionToken}"]`)
      if (await candidate.count()) matches.push(candidate)
    }
    if (matches.length !== 1) throw Error("Action reference is detached or ambiguous; read the page again")
    locator = matches[0]
  } else if (params.selector) {
    // Hasgard's existing selector contract selects the first match unless indexed.
    locator = scope.locator(params.selector).nth(params.index ?? 0)
  } else if (Number.isFinite(params.x) && Number.isFinite(params.y)) {
    pointHandle = await scope
      .locator("html")
      .evaluateHandle((root, { x, y }) => root.ownerDocument.elementFromPoint(x, y), params)
    locator = pointHandle.asElement()
    if (!locator) {
      await pointHandle.dispose()
      throw Error(`No element at (${params.x}, ${params.y})`)
    }
  } else throw Error("Action requires a selector, reference or coordinates")

  const options = { timeout }
  try {
    if (pointHandle && !position)
      position = await locator.evaluate((element, { x, y }) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        // Playwright positions are relative to the padding box; coordinates in
        // Hasgard's protocol are CSS pixels in the selected frame's viewport.
        return {
          x: x - rect.left - parseFloat(style.borderLeftWidth),
          y: y - rect.top - parseFloat(style.borderTopWidth)
        }
      }, params)
    switch (method) {
      case "click":
      case "dblclick":
        await locator.click({
          ...options,
          button: params.button,
          modifiers: params.modifiers,
          position,
          clickCount: method === "dblclick" ? 2 : params.clickCount
        })
        break
      case "hover":
        await locator.hover({ ...options, position, modifiers: params.modifiers })
        break
      case "fill":
        await locator.fill(params.value, options)
        break
      case "type":
        if (pointHandle) await locator.type(params.text, options)
        else await locator.pressSequentially(params.text, options)
        break
      case "check": {
        const checked =
          params.checked ?? ((await locator.getAttribute("type")) === "radio" || !(await locator.isChecked()))
        await locator.setChecked(checked, options)
        break
      }
      case "select": {
        const value = await locator.evaluate((element, wanted) => {
          if (element.tagName !== "SELECT") throw Error("select requires a select element")
          const items = [...element.options]
          const item = items.find((o) => o.value === wanted) ?? items.find((o) => o.text.trim() === wanted.trim())
          if (!item) throw Error(`No option matches ${JSON.stringify(wanted)}`)
          return item.value
        }, String(params.value))
        await locator.selectOption(value, options)
        break
      }
      default:
        throw Error(`Unsupported Playwright action: ${method}`)
    }
    return { ok: true }
  } finally {
    await pointHandle?.dispose()
  }
}
