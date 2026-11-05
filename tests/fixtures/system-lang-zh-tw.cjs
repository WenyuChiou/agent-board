const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
Intl.DateTimeFormat.prototype.resolvedOptions = function (...args) {
  return { ...resolvedOptions.apply(this, args), locale: 'zh-TW' }
}
