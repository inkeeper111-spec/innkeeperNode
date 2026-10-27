import { MenuCategory, MenuItem, FoodOrder, Reservation, Invoice, Room, RestaurantTable, Property } from '../models/index.js';
import { FOOD_ORDER_STATUS, RESERVATION_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import mongoose from 'mongoose';
import { notifyRoles } from '../services/notificationService.js';

const resolveRestaurantProperty = async (req, res) => {
  const propertyId = req.propertyId || req.user.propertyId
    || (req.user.role === 'super_admin' && (req.query.propertyId || req.body?.propertyId));
  if (!propertyId) {
    res.status(403).json({ success: false, message: 'A restaurant property must be assigned to this account.' });
    return null;
  }

  if (!mongoose.isValidObjectId(propertyId)) {
    res.status(400).json({ success: false, message: 'A valid restaurant property is required.' });
    return null;
  }

  const property = await Property.findOne({ _id: propertyId, hotelId: req.hotelId, status: 'active' }).select('_id');
  if (!property) {
    res.status(404).json({ success: false, message: 'Restaurant property not found or inactive.' });
    return null;
  }

  return property._id;
};

export const getTables = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    if (req.query.includeInactive === 'true' && !['hotel_admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only hotel administrators can view inactive tables.' });
    }

    const tableFilter = { hotelId: req.hotelId, propertyId };
    if (req.query.includeInactive !== 'true') tableFilter.isActive = true;
    const tables = await RestaurantTable.find(tableFilter)
      .sort({ tableNumber: 1 })
      .lean();
    const data = tables.map((table) => ({
      ...table,
      currentStatus: table.activeOrderId ? 'occupied' : table.status
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

export const createTable = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const capacity = Number(req.body.capacity ?? 4);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!Number.isInteger(capacity) || capacity < 1) {
      return res.status(400).json({ success: false, message: 'Table capacity must be a positive whole number.' });
    }

    let table;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const lastTable = await RestaurantTable.findOne({ hotelId: req.hotelId, propertyId })
        .sort({ tableNumber: -1 })
        .select('tableNumber')
        .lean();

      try {
        table = await RestaurantTable.create({
          hotelId: req.hotelId,
          propertyId,
          tableNumber: (lastTable?.tableNumber || 0) + 1,
          name,
          capacity,
          status: 'available'
        });
        break;
      } catch (err) {
        if (err.code !== 11000 || attempt === 4) throw err;
      }
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'CREATE_RESTAURANT_TABLE',
      entity: 'RestaurantTable',
      entityId: table._id,
      details: { tableNumber: table.tableNumber, propertyId: String(propertyId) },
      req
    });

    res.status(201).json({ success: true, data: table });
  } catch (err) {
    next(err);
  }
};

export const updateTable = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const updates = {};
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string') {
        return res.status(400).json({ success: false, message: 'Table name must be text.' });
      }
      updates.name = req.body.name.trim();
    }
    if (req.body.capacity !== undefined) {
      const capacity = Number(req.body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) {
        return res.status(400).json({ success: false, message: 'Table capacity must be a positive whole number.' });
      }
      updates.capacity = capacity;
    }
    if (req.body.status !== undefined) {
      if (!['available', 'reserved'].includes(req.body.status)) {
        return res.status(400).json({ success: false, message: 'Table status must be available or reserved.' });
      }
      updates.status = req.body.status;
    }
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({ success: false, message: 'isActive must be a boolean.' });
      }
      updates.isActive = req.body.isActive;
    }

    const filter = { _id: req.params.id, hotelId: req.hotelId, propertyId };
    if (updates.isActive === false) filter.activeOrderId = null;
    const table = await RestaurantTable.findOneAndUpdate(filter, { $set: updates }, {
      new: true,
      runValidators: true
    });
    if (!table) {
      return res.status(404).json({
        success: false,
        message: 'Table not found or cannot be deactivated while an order is active.'
      });
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_RESTAURANT_TABLE',
      entity: 'RestaurantTable',
      entityId: table._id,
      details: updates,
      req
    });

    res.json({ success: true, data: table });
  } catch (err) {
    next(err);
  }
};

export const getMenu = async (req, res, next) => {
  try {
    const categories = await MenuCategory.find({ hotelId: req.hotelId, isActive: true }).sort({ displayOrder: 1 });
    const items = await MenuItem.find({ hotelId: req.hotelId, isAvailable: true }).populate('categoryId');

    res.json({
      success: true,
      data: {
        categories,
        items
      }
    });
  } catch (err) {
    next(err);
  }
};

export const createCategory = async (req, res, next) => {
  try {
    const category = await MenuCategory.create({
      ...req.body,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: category });
  } catch (err) {
    next(err);
  }
};

export const updateCategory = async (req, res, next) => {
  try {
    const category = await MenuCategory.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    );
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found.' });
    }
    res.json({ success: true, data: category });
  } catch (err) {
    next(err);
  }
};

export const createMenuItem = async (req, res, next) => {
  try {
    const item = await MenuItem.create({
      ...req.body,
      hotelId: req.hotelId
    });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

export const updateMenuItem = async (req, res, next) => {
  try {
    const item = await MenuItem.findOneAndUpdate(
      { _id: req.params.id, hotelId: req.hotelId },
      req.body,
      { new: true }
    ).populate('categoryId');
    if (!item) {
      return res.status(404).json({ success: false, message: 'Menu item not found.' });
    }
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
};

export const getOrders = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;
    const { status, orderType } = req.query;
    const filter = { hotelId: req.hotelId, propertyId };

    if (status && status !== 'all') filter.status = status;
    if (orderType && orderType !== 'all') filter.orderType = orderType;

    const orders = await FoodOrder.find(filter)
      .populate('roomId', 'roomNumber')
      .populate('tableId', 'tableNumber name')
      .populate('reservationId', 'bookingReference guestName')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
};

export const createOrder = async (req, res, next) => {
  let lockedTableId = null;
  let activeOrderId = null;
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;
    const {
      orderType = 'dine_in',
      tableId,
      roomId = null,
      reservationId = null,
      items, // [{ menuItemId, quantity, specialInstructions }]
      discountAmount = 0
    } = req.body;

    if (!['dine_in', 'room_service', 'takeaway'].includes(orderType)) {
      return res.status(400).json({ success: false, message: 'Invalid restaurant order type.' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item is required.' });
    }
    if (orderType === 'dine_in' && !tableId) {
      return res.status(400).json({ success: false, message: 'Select a restaurant table for dine-in orders.' });
    }
    if (orderType === 'dine_in' && !mongoose.isValidObjectId(tableId)) {
      return res.status(400).json({ success: false, message: 'Select a valid restaurant table.' });
    }

    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItem = await MenuItem.findOne({ _id: item.menuItemId, hotelId: req.hotelId });
      if (!menuItem) {
        return res.status(400).json({ success: false, message: `Menu item not found: ${item.menuItemId}` });
      }

      const itemTotal = menuItem.price * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        menuItemId: menuItem._id,
        name: menuItem.name,
        quantity: item.quantity,
        unitPrice: menuItem.price,
        amount: itemTotal,
        specialInstructions: item.specialInstructions || ''
      });
    }

    const taxAmount = Math.round(subtotal * 0.05 * 100) / 100; // 5% F&B tax
    const totalAmount = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;

    let roomNumber = '';
    let guestName = '';
    let guestId = null;

    if (roomId) {
      const room = await Room.findById(roomId);
      if (!room || String(room.hotelId) !== String(req.hotelId) || String(room.propertyId) !== String(propertyId)) {
        return res.status(400).json({ success: false, message: 'Room is not part of this restaurant property.' });
      }
      roomNumber = room.roomNumber;
    }

    if (reservationId) {
      const resv = await Reservation.findOne({ _id: reservationId, hotelId: req.hotelId, propertyId });
      if (!resv) {
        return res.status(400).json({ success: false, message: 'Reservation is not part of this restaurant property.' });
      }
      guestName = resv.guestName;
      guestId = resv.guestId;
    }

    let table = null;
    if (orderType === 'dine_in') {
      table = await RestaurantTable.findOne({
        _id: tableId,
        hotelId: req.hotelId,
        propertyId,
        isActive: true,
        status: 'available',
        activeOrderId: null
      }).lean();
      if (!table) {
        return res.status(409).json({
          success: false,
          message: 'This table is unavailable or already assigned to an active order.'
        });
      }

      activeOrderId = new mongoose.Types.ObjectId();
      const lockedTable = await RestaurantTable.findOneAndUpdate({
        _id: table._id,
        hotelId: req.hotelId,
        propertyId,
        isActive: true,
        status: 'available',
        activeOrderId: null
      }, {
        $set: { activeOrderId }
      }, { new: true });

      if (!lockedTable) {
        return res.status(409).json({
          success: false,
          message: 'This table was just assigned to another order. Select a different table.'
        });
      }
      lockedTableId = lockedTable._id;
    }

    const orderNumber = generateReference('ORD');
    const order = await FoodOrder.create({
      _id: activeOrderId || new mongoose.Types.ObjectId(),
      hotelId: req.hotelId,
      propertyId,
      orderNumber,
      orderType,
      tableId: table?._id || null,
      tableNumber: table ? `Table ${table.tableNumber}` : '',
      tableNameSnapshot: table?.name || '',
      roomId,
      roomNumber,
      reservationId,
      guestId,
      guestName,
      items: orderItems,
      subtotal,
      taxAmount,
      discountAmount,
      totalAmount,
      status: FOOD_ORDER_STATUS.PENDING,
      paymentStatus: 'unpaid',
      createdBy: req.user._id
    });
    lockedTableId = null;

    await notifyRoles({
      hotelId: req.hotelId,
      roles: ['restaurant_staff'],
      title: 'New restaurant order',
      message: `Order ${order.orderNumber} is ready for kitchen preparation.`,
      module: 'restaurant',
      eventType: 'restaurant_order_created',
      relatedRecordId: order._id,
      priority: 'medium',
      link: '/restaurant',
      eventId: `restaurant-order-created:${order._id}`
    });

    res.status(201).json({
      success: true,
      message: 'Restaurant order placed successfully.',
      data: order
    });
  } catch (err) {
    if (lockedTableId && activeOrderId) {
      await RestaurantTable.updateOne(
        { _id: lockedTableId, activeOrderId },
        { $set: { activeOrderId: null } }
      );
    }
    next(err);
  }
};

export const updateOrderStatus = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;
    const { status } = req.body;
    const transitions = {
      [FOOD_ORDER_STATUS.PENDING]: [FOOD_ORDER_STATUS.ACCEPTED, FOOD_ORDER_STATUS.PREPARING, FOOD_ORDER_STATUS.CANCELLED],
      [FOOD_ORDER_STATUS.ACCEPTED]: [FOOD_ORDER_STATUS.PREPARING, FOOD_ORDER_STATUS.CANCELLED],
      [FOOD_ORDER_STATUS.PREPARING]: [FOOD_ORDER_STATUS.READY, FOOD_ORDER_STATUS.CANCELLED],
      [FOOD_ORDER_STATUS.READY]: [FOOD_ORDER_STATUS.SERVED, FOOD_ORDER_STATUS.CANCELLED],
      [FOOD_ORDER_STATUS.SERVED]: [],
      [FOOD_ORDER_STATUS.CANCELLED]: []
    };
    const order = await FoodOrder.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (!transitions[order.status]?.includes(status)) {
      return res.status(400).json({ success: false, message: `Order cannot transition from ${order.status} to ${status}.` });
    }

    const updated = await FoodOrder.findOneAndUpdate({
      _id: order._id,
      hotelId: req.hotelId,
      propertyId,
      status: order.status
    }, { $set: { status } }, { new: true });
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Order was updated concurrently. Refresh and try again.' });
    }

    if (updated.tableId && (status === FOOD_ORDER_STATUS.CANCELLED
      || (status === FOOD_ORDER_STATUS.SERVED && ['paid', 'transferred_to_folio'].includes(updated.paymentStatus)))) {
      await RestaurantTable.updateOne(
        { _id: updated.tableId, hotelId: req.hotelId, propertyId, activeOrderId: updated._id },
        { $set: { activeOrderId: null } }
      );
    }

    if ([FOOD_ORDER_STATUS.READY, FOOD_ORDER_STATUS.CANCELLED].includes(status)) {
      await notifyRoles({
        hotelId: req.hotelId,
        roles: ['restaurant_staff', 'hotel_admin'],
        title: status === FOOD_ORDER_STATUS.READY ? 'Order ready' : 'Order cancelled',
        message: `Restaurant order ${updated.orderNumber} is ${status}.`,
        module: 'restaurant',
        eventType: `restaurant_order_${status}`,
        relatedRecordId: updated._id,
        priority: status === FOOD_ORDER_STATUS.CANCELLED ? 'high' : 'medium',
        link: '/restaurant',
        eventId: `restaurant-order-${status}:${updated._id}`
      });
    }

    res.json({ success: true, message: `Order status updated to ${status}.`, data: updated });
  } catch (err) {
    next(err);
  }
};

export const settleOrder = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const order = await FoodOrder.findOneAndUpdate({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId,
      status: FOOD_ORDER_STATUS.SERVED,
      paymentStatus: 'unpaid'
    }, { $set: { paymentStatus: 'paid', paymentMethod: req.body.paymentMethod || 'cash' } }, { new: true });

    if (!order) {
      return res.status(409).json({
        success: false,
        message: 'Only served, unpaid orders can be settled.'
      });
    }

    if (order.tableId) {
      await RestaurantTable.updateOne(
        { _id: order.tableId, hotelId: req.hotelId, propertyId, activeOrderId: order._id },
        { $set: { activeOrderId: null } }
      );
    }

    await notifyRoles({
      hotelId: req.hotelId,
      roles: ['hotel_admin'],
      title: 'Restaurant bill settled',
      message: `Restaurant order ${order.orderNumber} was paid.`,
      module: 'restaurant',
      eventType: 'restaurant_order_paid',
      relatedRecordId: order._id,
      link: '/restaurant',
      eventId: `restaurant-order-paid:${order._id}`
    });

    res.json({ success: true, message: 'Order settled and table released.', data: order });
  } catch (err) {
    next(err);
  }
};

/**
 * Transfer restaurant charge to guest's room folio (Invoice)
 */
export const transferToRoomFolio = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;
    const { orderId, reservationId } = req.body;

    const order = await FoodOrder.findOne({ _id: orderId, hotelId: req.hotelId, propertyId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Food order not found.' });
    }

    if (order.isBilledToRoomFolio) {
      return res.status(400).json({ success: false, message: 'Order charges have already been transferred to folio.' });
    }

    const reservation = await Reservation.findOne({
      _id: reservationId || order.reservationId,
      hotelId: req.hotelId,
      status: RESERVATION_STATUS.CHECKED_IN
    });

    if (!reservation) {
      return res.status(400).json({
        success: false,
        message: 'Active in-house checked-in reservation not found for folio billing.'
      });
    }

    // Find active invoice for this reservation
    const invoice = await Invoice.findOne({ reservationId: reservation._id, hotelId: req.hotelId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found for this reservation.' });
    }

    // Append restaurant line item to the invoice
    invoice.items.push({
      description: `Restaurant Order #${order.orderNumber} (${order.orderType})`,
      quantity: 1,
      unitPrice: order.totalAmount,
      amount: order.totalAmount,
      itemType: 'restaurant',
      sourceRef: order._id.toString()
    });

    invoice.subtotal = Math.round((invoice.subtotal + order.totalAmount) * 100) / 100;
    invoice.totalAmount = Math.round((invoice.totalAmount + order.totalAmount) * 100) / 100;
    invoice.balanceAmount = Math.round((invoice.totalAmount - invoice.paidAmount) * 100) / 100;
    await invoice.save();

    // Update reservation total & balance
    reservation.totalAmount = Math.round((reservation.totalAmount + order.totalAmount) * 100) / 100;
    reservation.balanceAmount = Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100;
    await reservation.save();

    // Mark order as billed to room folio
    order.isBilledToRoomFolio = true;
    order.paymentStatus = 'transferred_to_folio';
    order.reservationId = reservation._id;
    await order.save();

    if (order.tableId && order.status === FOOD_ORDER_STATUS.SERVED) {
      await RestaurantTable.updateOne(
        { _id: order.tableId, hotelId: req.hotelId, propertyId, activeOrderId: order._id },
        { $set: { activeOrderId: null } }
      );
    }

    await logAudit({
      hotelId: req.hotelId,
      action: 'FOLIO_TRANSFER',
      entity: 'FoodOrder',
      entityId: order._id,
      details: { orderNumber: order.orderNumber, bookingReference: reservation.bookingReference, amount: order.totalAmount },
      req
    });

    res.json({
      success: true,
      message: `Charge of $${order.totalAmount} transferred to Room Folio (${reservation.bookingReference}).`,
      data: {
        order,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};
