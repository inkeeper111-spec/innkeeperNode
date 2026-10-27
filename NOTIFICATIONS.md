# Notification system

## Delivery and access

Notifications are persisted for an explicit recipient user. `notificationService.js` resolves hotel roles against active users in the authenticated hotel and supports direct recipients for assigned work and guest accounts. Hotel and role values are derived server-side; notification retrieval and read updates are scoped to the authenticated recipient. Super admins see only platform notifications addressed to their account.

The current application has no WebSocket server. The authenticated client polls the notification API every 10 seconds while its tab is visible; notifications remain in MongoDB for offline recovery. This provides in-app updates without introducing a second transport or exposing bearer tokens through a socket URL.

Notifications include module, event type, record reference, priority, read timestamp, and an event idempotency key. A unique event id per recipient prevents duplicate records when an event is retried. Notification creation happens after the associated database operation succeeds.

## Integrated event mapping

| Module | Event | Recipients |
|---|---|---|
| Platform | Hotel registration and status change | Active super admins; changed hotel's owner for status |
| Reservations | Creation, approval, rejection, check-out | Hotel admins and receptionists; guest account for own reservation when registered |
| Rooms | Creation, update, status changes | Hotel admins; receptionists on status changes |
| Guests | New guest profile | Hotel admins and receptionists |
| Expenses | Expense creation and status update | Hotel admins |
| Restaurant | New order, ready/cancelled order, settled bill | Restaurant staff; hotel admins for important status and payment events |
| Inventory | New item and low-stock threshold | Hotel admins; restaurant staff for low-stock alerts |
| Housekeeping | Task assignment and completion/inspection | Assigned housekeeping employee; hotel admins and receptionists on completion |
| Maintenance | Ticket creation, assignment, reassignment, status | Assigned maintenance employee and hotel admins |
| Leave | Submission, decision, cancellation | Requesting employee and hotel admins |
| Payroll | Completed payroll processing | Hotel admins |
| Payments | Failed invoice payment | Hotel admins and receptionists |

Messages avoid guest identity details and payment credentials. Guest in-app messages are sent only when a matching guest user account exists; existing email notices remain in place where implemented.

## API

- `GET /api/v1/notifications`: authenticated recipient's notification page; supports `page`, `limit`, `module`, `priority`, `isRead`, `startDate`, and `endDate`. Response includes unread count and pagination metadata.
- `PATCH /api/v1/notifications/:id/read`: mark one of the authenticated user's notifications read.
- `PATCH /api/v1/notifications/read-all`: mark that user's notifications read.

## Remaining integrations

Subscriptions, automated overdue reminders, guest room-service/housekeeping request lifecycle, configurable preferences and daily summaries, external email/push delivery, and security-error escalation do not currently have complete business workflows in the application and are not represented by synthetic notifications. The notification service currently persists events synchronously; it does not yet use a transactional outbox or external queue. The client polling interval can be replaced by authenticated server-sent events or WebSockets if the deployment requires lower latency.
