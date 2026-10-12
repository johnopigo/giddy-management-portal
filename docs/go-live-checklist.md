# Go-live checklist

Tick each item before the portal replaces the current way of working. **Owner** = Giddy management,
**IT** = the IT administrator, **Partner** = the Spa partner.

## Two to four weeks before

- [ ] **Owner**: choose the cloud provider and the portal's web address. ([deployment.md](deployment.md) §1)
- [ ] **IT**: create the server, set up DNS, configure `.env.production`, start the portal. (§2–3)
- [ ] **IT**: confirm `https://<address>` shows the sign-in page with a valid certificate.
- [ ] **IT**: run the tenant setup; hand out the three one-time passwords privately. (§4)
- [ ] **Owner, IT, Partner**: sign in and choose new passwords.
- [ ] **IT**: create every staff account with the right roles and units. Check the Spa partner's staff can see only the Spa.
- [ ] **Owner + Partner**: fill in the Spa revenue-share terms in **Partnership** (rate, basis, who collects) and agree them.
- [ ] **Each unit manager**: check VAT and service charge rates in **Organisation → settings**.

## Data

- [ ] **Owner**: export customers, suppliers, items with prices, room types and rooms from the current records into the
      [templates](import-templates); run each import as a dry run, fix problems, then import. ([data-import.md](data-import.md))
- [ ] **Partner**: import Spa items and set up Spa resources, opening hours and services (with deposits and intake requirements).
- [ ] **Owner**: set up Studio booths, hours and services.
- [ ] **Each unit**: create stock locations (main stores and department stores).
- [ ] **Accountant**: decide the opening balances for cash, bank and other accounts on go-live day.

## Payments and online booking

- [ ] **Owner**: Paystack business account verified; live secret key in `.env.production`; webhook URL set in the
      Paystack dashboard. (§5)
- [ ] **Each unit**: set online deposit, hold time, cancellation window and limits; tick "Bookable online" on services.
- [ ] Make one real online booking per unit with a small deposit; check it reaches the front desk or diary and the
      payment lands on the guest's bill; refund it from Paystack.
- [ ] Put the booking page link on the website and social media only after the test bookings work.

## Safety

- [ ] **IT**: nightly backups scheduled **and copied off the server**; VM snapshots on. (§6)
- [ ] **IT**: practise a restore on a second server; confirm "Audit trail intact" and that people can sign in.
- [ ] **IT**: uptime monitor on `https://<address>/api/ready`, alerting the IT administrator and the Owner.
- [ ] **IT**: `.env.production` stored in the business password manager; server SSH limited to named keys.
- [ ] **Owner**: open **Audit** and run the chain check; it should report intact.

## Training (the week before)

- [ ] Front desk: reservations, check-in/out, folios, charge-to-room, the night audit.
- [ ] Cashiers and bar/kitchen: the till, receipts, voids, charging to a room.
- [ ] Storekeepers: receiving goods, transfers, item requests, stock adjustments.
- [ ] Spa and Studio reception: the diary, booking, moving, check-in, bills, intake forms (Spa).
- [ ] Managers: approvals, month-end close, reports, settlements (Owner and Partner).

## Go-live day

- [ ] Count stock in every location and import it as opening stock.
- [ ] Enter guests currently in-house and future bookings already promised.
- [ ] Record the opening balances.
- [ ] Run the first night audit at the end of the day; check the dashboard and reports the next morning.
- [ ] Take a backup by hand at the end of the day: `ops/backup.sh`.

## The first month

- [ ] Check backups arrive off-site every day.
- [ ] Review the **Audit** log and the notifications weekly.
- [ ] Close the first month in **Finance**; issue and agree the first Spa settlement.
