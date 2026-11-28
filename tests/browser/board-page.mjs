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

  async openQuestion(words) {
    const card = this.question(words)
    const rail = this.page.locator('#detail-rail')
    const isWide = await this.page.evaluate(() => window.innerWidth >= 1440)
    if (isWide) {
      if (!(await card.evaluate(node => node.classList.contains('selected')))) {
        await card.locator('button.q-toggle').click()
      }
      await rail.waitFor({ state: 'visible' })
      return rail
    }
    const more = card.locator('button.q-toggle')
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
    return card
  }

  // A task is one row; pressing it opens its details in the side rail from 1440 px up and in place below.
  task(title) {
    return this.main.locator('li.row').filter({ hasText: title })
  }

  async openTask(title) {
    const task = this.task(title)
    // Idle, stopped and done rows sit in a closed fold on the Overview (#1023): open the one that holds this row first.
    const shelf = this.main.locator('.shelf:not(.open)').filter({ has: this.page.locator('li.row').filter({ hasText: title }) })
    if (await shelf.count()) await shelf.first().locator(':scope > .shelf-head').click()
    await task.locator('.row-btn').first().click()
    const rail = this.page.locator('#detail-rail')
    if (await rail.isVisible()) return rail
    return task
  }

  // The agent's button is in the icon row on a phone and in the sidebar from the rail up; press the one that shows.
  async selectAgent(agent) {
    await this.page.locator(`[data-agent="${agent}"]:visible`).first().click()
  }

  // Theme choices live in the shared Settings panel.
  async chooseTheme(theme) {
    const want = theme.toLowerCase()
    const toggle = this.page.locator('[data-settings-toggle]:visible').first()
    if ((await toggle.getAttribute('data-now')) === want) return
    if (!(await this.page.locator('#settings').isVisible())) await toggle.click()
    await this.page.locator(`[data-theme-set="${want}"]:visible`).first().click()
    await this.page.waitForFunction(value => document.documentElement.getAttribute('data-theme') === value, want)
    await this.page.locator('#settings-close').click()
  }
}
