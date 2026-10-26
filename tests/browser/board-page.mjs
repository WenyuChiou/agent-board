export class BoardPage {
  constructor(page) {
    this.page = page
    this.main = page.getByRole('main')
    this.filters = page.getByRole('complementary', { name: 'Sort and filter' })
    this.pasteInput = page.locator('textarea#paste')
  }

  async open(url) {
    await this.page.goto(url)
    await this.page.getByRole('heading', { name: 'Progress', level: 1 }).waitFor()
  }

  async pasteProgress(block) {
    await this.main.getByText('Paste a progress block from a web chat (Muse, dot)', { exact: true }).click()
    await this.pasteInput.fill(block)
    await this.main.getByRole('button', { name: 'Add to the board', exact: true }).click()
  }

  question(words) {
    return this.main.getByRole('article').filter({ hasText: words })
  }

  task(title) {
    return this.main.locator('details').filter({ hasText: title })
  }

  async openTask(title) {
    const task = this.task(title)
    await task.getByText(title, { exact: true }).click()
    return task
  }

  async selectAgent(agent) {
    const agents = this.filters.getByRole('heading', { name: /agents/i, level: 3 })
    await agents.waitFor()
    await agents.locator('..').getByRole('button', { name: new RegExp(agent, 'i') }).click()
  }

  async chooseTheme(theme) {
    await this.page.getByRole('group', { name: /theme/i }).getByRole('button', { name: theme, exact: true }).click()
  }
}
