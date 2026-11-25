import base from './playwright.config'
export default { ...base, reporter: 'line', use: { ...base.use, baseURL: 'http://localhost:5199' } }
