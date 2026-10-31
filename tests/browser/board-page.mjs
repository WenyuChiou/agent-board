export class BoardPage {
  constructor(page) {
    this.page = page
    this.main = page.getByRole('main')
  }

  async open(url) {
    await this.page.goto(url)
    // The heading is in the header on a phone and in the sidebar's place from the rail up, where the header is hidden.
    await this.page.getByRole('heading', { name: 'Agent Board', level: 1, includeHidden: true }).waitFor({ state: 'attached' })
    await this.page.locator('#board > *').first().waitFor()
  }

  // A question or stuck task on the Needs you sheet.
  question(words) {
    return this.main.getByRole('article').filter({ hasText: words })
  }

  // A task is one row; pressing it opens its steps and actions in place.
  task(title) {
    return this.main.locator('li.row').filter({ hasText: title })
  }

  async openTask(title) {
    const task = this.task(title)
    await task.locator('.row-btn').first().click()
    return task
  }

  // The agent's button is in the icon row on a phone and in the sidebar from the rail up; press the one that shows.
  async selectAgent(agent) {
    await this.page.locator(`[data-agent="${agent}"]:visible`).first().click()
  }

  // One icon button switches between the two themes; it shows the theme it will switch to.
  async chooseTheme(theme) {
    const want = theme.toLowerCase()
    const toggle = this.page.locator('[data-theme-toggle]:visible').first()
    if ((await toggle.getAttribute('data-now')) === want) return
    await toggle.click()
    await this.page.waitForFunction(value => document.documentElement.getAttribute('data-theme') === value, want)
  }
}
