import { notifyRoles, notifyUsers } from './notificationService.js';

const MANAGEMENT_ROLES = ['hotel_admin'];

export const notifyJobRejection = async ({
  hotelId,
  jobId,
  jobReference,
  jobTitle,
  assignedTo,
  assignedBy,
  assigneeName,
  actorId,
  reason,
  rejectedAt,
  module,
  eventType,
  link
}) => {
  const message = `${jobTitle} ${jobReference} was rejected by ${assigneeName}. Reason: ${reason} Rejected at ${rejectedAt.toISOString()}.`;
  const eventId = `${module}-rejected:${jobId}`;
  const managerRecipients = assignedBy && String(assignedBy) !== String(actorId)
    ? [assignedBy]
    : [];

  await Promise.all([
    notifyUsers({
      hotelId,
      userIds: managerRecipients,
      title: 'Assigned job rejected',
      message,
      module,
      eventType,
      relatedRecordId: jobId,
      priority: 'high',
      link,
      eventId
    }),
    notifyRoles({
      hotelId,
      roles: MANAGEMENT_ROLES,
      excludeUserIds: [assignedBy].filter(Boolean),
      title: 'Assigned job rejected',
      message,
      module,
      eventType,
      relatedRecordId: jobId,
      priority: 'high',
      link,
      eventId
    }),
    String(assignedTo) === String(actorId)
      ? notifyUsers({
        hotelId,
        userIds: [assignedTo],
        title: 'Job rejection recorded',
        message: `${message} Your rejection was recorded.`,
        module,
        eventType,
        relatedRecordId: jobId,
        priority: 'medium',
        link,
        eventId: `${eventId}:assignee`
      })
      : Promise.resolve([])
  ]);
};
