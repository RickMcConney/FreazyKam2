import { describe, it, expect } from 'vitest'
import { parseSdListing, sdJoin, sdParent, sdDownloadPath, sdRunCommand, sdUploadForm } from './sdFiles'

describe('parseSdListing', () => {
  const reply = JSON.stringify({
    files: [
      { name: 'b.nc', shortname: 'b.nc', size: '2.00 KB', datetime: '' },
      { name: 'jobs', shortname: 'jobs', size: '-1', datetime: '' },
      { name: 'a10.nc', size: '1 B' },
      { name: 'a9.nc', size: '1 B' },
    ],
    path: '/', total: '7.40 GB', used: '1.00 MB', occupation: '1', status: 'Ok',
  })

  it('lists directories first, then files in natural order (a9 before a10)', () => {
    expect(parseSdListing(reply)!.files.map((f) => f.name)).toEqual(['jobs', 'a9.nc', 'a10.nc', 'b.nc'])
  })

  it('reads a size of -1 as a directory and keeps the controller\'s own size text', () => {
    const files = parseSdListing(reply)!.files
    expect(files[0]).toEqual({ name: 'jobs', size: '-1', isDir: true })
    expect(files.find((f) => f.name === 'b.nc')).toEqual({ name: 'b.nc', size: '2.00 KB', isDir: false })
  })

  it('reads card usage, the occupation as a number', () => {
    expect(parseSdListing(reply)).toMatchObject({ path: '/', total: '7.40 GB', used: '1.00 MB', occupation: 1 })
  })

  it('refuses a reply that is not a listing', () => {
    expect(parseSdListing('<html>404</html>')).toBeNull()
    expect(parseSdListing('{"status":"no SD card"}')).toBeNull()
  })
})

describe('SD paths', () => {
  it('joins without doubling the slash at the root', () => {
    expect(sdJoin('/', 'a.nc')).toBe('/a.nc')
    expect(sdJoin('/jobs', 'a.nc')).toBe('/jobs/a.nc')
  })

  it('goes up one directory, stopping at the root', () => {
    expect(sdParent('/jobs/old')).toBe('/jobs')
    expect(sdParent('/jobs')).toBe('/')
    expect(sdParent('/')).toBe('/')
  })

  it('encodes each segment of a download path but keeps the slashes', () => {
    expect(sdDownloadPath('/my jobs', 'a#1.nc')).toBe('/sd/my%20jobs/a%231.nc')
  })

  it('runs a file by its full path on the card', () => {
    expect(sdRunCommand('/', 'a.nc')).toBe('$SD/Run=/a.nc')
    expect(sdRunCommand('/jobs', 'a.nc')).toBe('$SD/Run=/jobs/a.nc')
  })

  it('sends the size field BEFORE the file, named by the full path, so the controller can check the upload arrived whole', () => {
    const blob = new Blob(['G0 X1\n'])
    const form = sdUploadForm('/jobs', blob, 'a.nc', new Date(2026, 9, 6, 13, 5, 9))
    expect(form.map((f) => f[0])).toEqual(['path', '/jobs/a.ncS', '/jobs/a.ncT', 'myfiles'])
    expect(form[1][1]).toBe('6')
    expect(form[2][1]).toBe('2026-10-06-13-05-09')
    expect(form[3][2]).toBe('/jobs/a.nc')
  })
})
