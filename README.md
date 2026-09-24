# Estate Ledger — offline real estate & partnership ledger for iPhone

A web app you install on your iPhone from Safari ("Add to Home Screen"). It runs **fully offline**. You don't need the App Store, a Mac, an emulator or a server, and all data stays on the phone (IndexedDB).

## Features
- **Properties & units**: multi-unit properties, ownership % per partner, occupancy.
- **Rentals**: tenants and leases, a monthly rent roll (paid / partial / overdue) and a per-lease rent balance.
- **Security deposits**: tracks deposits received, kept (for unpaid rent or damages) and refunded, per lease.
- **Ledger**: income, expenses, deposits, partner contributions and withdrawals, partner-to-partner settlements, and account transfers.
- **Partner splitting**:
  - Expenses paid from the common account, or by one partner personally.
  - Rent collected by one partner personally.
  - A partner taking money out of the common account for personal use.
  - Custom split on any entry.
  - Shows who owes whom, with a suggested settlement.
- **Attachments**: bank statements, screenshots, receipts and PDFs on any entry, property, lease or tenant.
- **Excel export** (.xlsx, 11 sheets): summary, properties, units, tenants, leases, full ledger with each partner's split, partner balances, accounts, rent roll, P&L and documents.
- **Backup & restore**: one .zip holding all data and documents. Save it to Files/iCloud and restore it on any device.

## Install on iPhone (one time)
The app has to be opened from a web address once. After that it runs from the phone's cache with no connection. The free option is GitHub Pages:

1. Merge this branch into `main`.
2. On GitHub, go to **Settings → Pages → Build and deployment**. Choose *Deploy from a branch*, then `main` and `/ (root)`, and save. (Free GitHub Pages needs the repo to be public. The repo holds only app code, never your data.)
3. On the iPhone, open `https://<your-username>.github.io/explore_local_app/` in **Safari**.
4. Tap **Share → Add to Home Screen**.
5. Open **Estate Ledger** from the Home Screen. It now works in Airplane Mode.

Other ways to host it: any static host (for example, drag the folder onto Netlify Drop). You only need the hosting for the first load and for updates.

## Keep your data safe
- The data lives only in the app on your phone. Deleting the Home Screen app or clearing Safari website data erases it.
- Use **More → Export & backup → Create full backup** regularly and save the zip to Files or iCloud Drive. The app reminds you when a backup is overdue.

## Development
Plain HTML/CSS/JS with no build step and no third-party libraries (the XLSX and ZIP writers are in `js/zip.js`). Serve the folder with any static server, e.g. `python3 -m http.server`.
When you change app files, bump `VERSION` in `sw.js` so installed phones pick up the update.
