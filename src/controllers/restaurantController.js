import {
  MenuCategory, MenuItem, FoodOrder, Reservation, Invoice, Room, RestaurantTable, Property, InventorySettings
} from '../models/index.js';
import { FOOD_ORDER_STATUS, RESERVATION_STATUS } from '../config/constants.js';
import { generateReference } from '../utils/reference.js';
import { logAudit } from '../services/auditService.js';
import { formatCurrency } from '../utils/currency.js';
import mongoose from 'mongoose';
import { notifyRoles } from '../services/notificationService.js';
import {
  consumeRecipesForOrder, reverseRecipeConsumptionForOrder, runInventoryTransaction
} from '../services/inventoryService.js';

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
    const includeUnavailable = req.query.includeUnavailable === 'true';
    if (includeUnavailable && !['hotel_admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only hotel administrators can view unavailable menu items.'
      });
    }

    const categories = await MenuCategory.find({ hotelId: req.hotelId, isActive: true }).sort({ displayOrder: 1 });
    const itemFilter = { hotelId: req.hotelId };
    if (!includeUnavailable) itemFilter.isAvailable = true;
    const items = await MenuItem.find(itemFilter).populate('categoryId');

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

export const archivePreviousDayBills = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const beforeDate = req.body?.beforeDate;
    const cutoff = new Date(beforeDate);
    if (typeof beforeDate !== 'string' || !Number.isFinite(cutoff.getTime()) || cutoff > new Date()) {
      return res.status(400).json({
        success: false,
        message: 'A valid past cutoff date is required to archive previous bills.'
      });
    }
    const result = await FoodOrder.updateMany({
      hotelId: req.hotelId,
      propertyId,
      orderType: 'dine_in',
      status: FOOD_ORDER_STATUS.SERVED,
      paymentStatus: { $in: ['paid', 'transferred_to_folio'] },
      createdAt: { $lt: cutoff },
      archivedAt: null
    }, {
      $set: { archivedAt: new Date(), archivedBy: req.user._id }
    });

    await logAudit({
      hotelId: req.hotelId,
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'ARCHIVE_PREVIOUS_RESTAURANT_BILLS',
      entity: 'FoodOrder',
      details: { beforeDate: cutoff, archivedCount: result.modifiedCount },
      req
    });

    res.json({
      success: true,
      message: `${result.modifiedCount} closed bill${result.modifiedCount === 1 ? '' : 's'} archived. Unpaid bills were not changed.`,
      data: { archivedCount: result.modifiedCount }
    });
  } catch (err) {
    next(err);
  }
};

export const restoreArchivedBill = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const order = await FoodOrder.findOneAndUpdate({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId,
      orderType: 'dine_in',
      archivedAt: { $ne: null }
    }, {
      $set: { archivedAt: null, archivedBy: null }
    }, { new: true });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Archived table bill not found.' });
    }

    await logAudit({
      hotelId: req.hotelId,
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'RESTORE_ARCHIVED_RESTAURANT_BILL',
      entity: 'FoodOrder',
      entityId: order._id,
      details: { orderNumber: order.orderNumber },
      req
    });

    res.json({ success: true, message: 'Bill restored to the active table bills.', data: order });
  } catch (err) {
    next(err);
  }
};

const appendItemsToOpenTableOrder = async ({ req, propertyId, table, orderItems }) => {
  const existing = await FoodOrder.findOne({
    _id: table.activeOrderId,
    hotelId: req.hotelId,
    propertyId,
    tableId: table._id,
    orderType: 'dine_in',
    paymentStatus: 'unpaid',
    status: { $ne: FOOD_ORDER_STATUS.CANCELLED }
  });
  if (!existing) {
    return {
      error: {
        status: 409,
        message: 'This table bill is already closed. Refresh and choose the table again.'
      }
    };
  }

  const items = [
    ...existing.items.map((item) => item.toObject()),
    ...orderItems
  ];
  const subtotal = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const taxAmount = Math.round(subtotal * 0.05 * 100) / 100;
  const totalAmount = Math.round((subtotal - (existing.discountAmount || 0) + taxAmount) * 100) / 100;
  const nextStatus = existing.status === FOOD_ORDER_STATUS.SERVED
    ? FOOD_ORDER_STATUS.PENDING
    : existing.status;

  const updated = await FoodOrder.findOneAndUpdate({
    _id: existing._id,
    hotelId: req.hotelId,
    propertyId,
    paymentStatus: 'unpaid',
    status: existing.status,
    $expr: { $eq: [{ $size: '$items' }, existing.items.length] }
  }, {
    $set: { items, subtotal, taxAmount, totalAmount, status: nextStatus }
  }, { new: true });

  if (!updated) {
    return {
      error: {
        status: 409,
        message: 'This table order changed. Refresh and add the items again.'
      }
    };
  }

  await notifyRoles({
    hotelId: req.hotelId,
    roles: ['restaurant_staff'],
    title: 'Items added to a table',
    message: `More items were added to ${updated.tableNumber || `Table ${table.tableNumber}`} (${updated.orderNumber}).`,
    module: 'restaurant',
    eventType: 'restaurant_order_items_added',
    relatedRecordId: updated._id,
    priority: 'medium',
    link: '/restaurant',
    eventId: `restaurant-order-items-added:${updated._id}:${updated.items.length}`
  });

  return { order: updated };
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
        specialInstructions: item.specialInstructions || '',
        ingredientSubstitutions: item.ingredientSubstitutions || []
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
      const existingTable = await RestaurantTable.findOne({
        _id: tableId,
        hotelId: req.hotelId,
        propertyId,
        isActive: true
      });
      if (!existingTable) {
        return res.status(409).json({
          success: false,
          message: 'This table is unavailable or already assigned to an active order.'
        });
      }

      if (existingTable.activeOrderId) {
        const appended = await appendItemsToOpenTableOrder({
          req,
          propertyId,
          table: existingTable,
          orderItems
        });
        if (appended.error) {
          return res.status(appended.error.status).json({
            success: false,
            message: appended.error.message
          });
        }
        return res.status(200).json({
          success: true,
          message: 'Items added to the open table order.',
          data: appended.order
        });
      }

      if (existingTable.status !== 'available') {
        return res.status(409).json({
          success: false,
          message: 'This table is unavailable or already assigned to an active order.'
        });
      }

      table = existingTable.toObject();
      activeOrderId = new mongoose.Types.ObjectId();
      const lockedTable = await RestaurantTable.findOneAndUpdate({
        _id: existingTable._id,
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
    const updated = await runInventoryTransaction(async (session) => {
      const order = await FoodOrder.findOne({
        _id: req.params.id,
        hotelId: req.hotelId,
        propertyId
      }).session(session);
      if (!order) {
        throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
      }
      if (!transitions[order.status]?.includes(status)) {
        throw Object.assign(new Error(`Order cannot transition from ${order.status} to ${status}.`), { statusCode: 400 });
      }

      const settings = await InventorySettings.findOne({
        hotelId: req.hotelId,
        propertyId
      }).session(session);
      const deductionStatus = (settings?.recipeDeductionStage || 'prepared') === 'served'
        ? FOOD_ORDER_STATUS.SERVED
        : FOOD_ORDER_STATUS.READY;
      if (status === deductionStatus) {
        await consumeRecipesForOrder(order, session, { skipEmpty: true, recordedBy: req.user._id });
      }
      if (status === FOOD_ORDER_STATUS.CANCELLED) {
        await reverseRecipeConsumptionForOrder(order, session, req.user._id);
      }

      order.status = status;
      await order.save({ session });
      return order;
    });

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

export const updateBillAmounts = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const { itemUnitPrices = {}, discountAmount, reason } = req.body;
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    if (!cleanReason) {
      return res.status(400).json({ success: false, message: 'A reason is required for bill modifications.' });
    }

    const order = await FoodOrder.findOne({
      _id: req.params.id,
      hotelId: req.hotelId,
      propertyId
    });
    if (!order) return res.status(404).json({ success: false, message: 'Restaurant bill not found.' });
    if (order.paymentStatus !== 'unpaid'
      || [FOOD_ORDER_STATUS.CANCELLED, FOOD_ORDER_STATUS.SERVED].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'Paid or finalized restaurant bills cannot be edited directly.' });
    }

    const updates = order.items.map((item) => ({ ...item.toObject() }));
    const modificationEntries = [];
    const isItemIndexValid = (index) => Number.isInteger(index) && index >= 0 && index < updates.length;

    if (itemUnitPrices && typeof itemUnitPrices !== 'object') {
      return res.status(400).json({ success: false, message: 'itemUnitPrices must be an object keyed by item index.' });
    }

    for (const [key, rawValue] of Object.entries(itemUnitPrices || {})) {
      const index = Number(key);
      const revisedAmount = Number(rawValue);
      if (!isItemIndexValid(index)) {
        return res.status(400).json({ success: false, message: `Invalid bill item index: ${key}.` });
      }
      if (!Number.isFinite(revisedAmount) || revisedAmount < 0) {
        return res.status(400).json({ success: false, message: 'Unit prices must be zero or greater.' });
      }
      const originalAmount = updates[index].unitPrice;
      if (Math.abs(originalAmount - revisedAmount) > 0.001) {
        updates[index].unitPrice = revisedAmount;
        updates[index].amount = Math.round(revisedAmount * updates[index].quantity * 100) / 100;
        modificationEntries.push({
          field: 'unitPrice', itemIndex: index, originalAmount, revisedAmount,
          reason: cleanReason, editorId: req.user._id,
          editorName: req.user.name || req.user.email, timestamp: new Date()
        });
      }
    }

    let revisedDiscount = order.discountAmount;
    if (discountAmount !== undefined) {
      revisedDiscount = Number(discountAmount);
      if (!Number.isFinite(revisedDiscount) || revisedDiscount < 0) {
        return res.status(400).json({ success: false, message: 'Discount must be zero or greater.' });
      }
    }

    const subtotal = Math.round(updates.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    if (revisedDiscount > subtotal) {
      return res.status(400).json({ success: false, message: 'Discount cannot exceed the item subtotal.' });
    }
    if (Math.abs(order.discountAmount - revisedDiscount) > 0.001) {
      modificationEntries.push({
        field: 'discountAmount', originalAmount: order.discountAmount, revisedAmount: revisedDiscount,
        reason: cleanReason, editorId: req.user._id,
        editorName: req.user.name || req.user.email, timestamp: new Date()
      });
    }

    if (modificationEntries.length === 0) {
      return res.status(400).json({ success: false, message: 'No bill amount changes were provided.' });
    }

    const taxAmount = Math.round(subtotal * 0.05 * 100) / 100;
    const totalAmount = Math.round((subtotal - revisedDiscount + taxAmount) * 100) / 100;

    order.items = updates;
    order.subtotal = subtotal;
    order.taxAmount = taxAmount;
    order.discountAmount = revisedDiscount;
    order.totalAmount = totalAmount;
    order.amountModifications = [...order.amountModifications, ...modificationEntries];
    await order.save();

    await logAudit({
      hotelId: req.hotelId,
      action: 'UPDATE_RESTAURANT_BILL_AMOUNTS',
      entity: 'FoodOrder',
      entityId: order._id,
      details: { orderNumber: order.orderNumber, modifications: modificationEntries },
      req
    });

    const updated = await FoodOrder.findById(order._id)
      .populate('tableId', 'tableNumber name')
      .populate('amountModifications.editorId', 'name email');
    res.json({ success: true, message: 'Restaurant bill amounts updated.', data: updated });
  } catch (err) {
    next(err);
  }
};

export const settleOrder = async (req, res, next) => {
  try {
    const propertyId = await resolveRestaurantProperty(req, res);
    if (!propertyId) return;

    const order = await runInventoryTransaction(async (session) => {
      const current = await FoodOrder.findOne({
        _id: req.params.id,
        hotelId: req.hotelId,
        propertyId,
        status: FOOD_ORDER_STATUS.SERVED,
        paymentStatus: 'unpaid'
      }).session(session);
      if (!current) {
        throw Object.assign(new Error('Only served, unpaid orders can be settled.'), { statusCode: 409 });
      }
      current.paymentStatus = 'paid';
      current.paymentMethod = req.body.paymentMethod || 'cash';
      await current.save({ session });
      await consumeRecipesForOrder(current, session);
      if (current.tableId) {
        await RestaurantTable.updateOne(
          { _id: current.tableId, hotelId: req.hotelId, propertyId, activeOrderId: current._id },
          { $set: { activeOrderId: null } },
          { session }
        );
      }
      return current;
    });

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

    const result = await runInventoryTransaction(async (session) => {
      const order = await FoodOrder.findOne({ _id: orderId, hotelId: req.hotelId, propertyId }).session(session);
      if (!order) throw Object.assign(new Error('Food order not found.'), { statusCode: 404 });
      if (order.isBilledToRoomFolio || order.paymentStatus !== 'unpaid'
        || order.status !== FOOD_ORDER_STATUS.SERVED) {
        throw Object.assign(new Error('Only served, unpaid orders can be transferred to a room folio once.'), { statusCode: 409 });
      }

      const reservation = await Reservation.findOne({
        _id: reservationId || order.reservationId,
        hotelId: req.hotelId,
        status: RESERVATION_STATUS.CHECKED_IN
      }).session(session);
      if (!reservation) {
        throw Object.assign(new Error('Active in-house checked-in reservation not found for folio billing.'), { statusCode: 400 });
      }

      const invoice = await Invoice.findOne({ reservationId: reservation._id, hotelId: req.hotelId }).session(session);
      if (!invoice) throw Object.assign(new Error('Invoice not found for this reservation.'), { statusCode: 404 });
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
      await invoice.save({ session });

      reservation.totalAmount = Math.round((reservation.totalAmount + order.totalAmount) * 100) / 100;
      reservation.balanceAmount = Math.round((reservation.totalAmount - reservation.paidAmount) * 100) / 100;
      await reservation.save({ session });

      order.isBilledToRoomFolio = true;
      order.paymentStatus = 'transferred_to_folio';
      order.reservationId = reservation._id;
      await order.save({ session });
      await consumeRecipesForOrder(order, session);
      if (order.tableId) {
        await RestaurantTable.updateOne(
          { _id: order.tableId, hotelId: req.hotelId, propertyId, activeOrderId: order._id },
          { $set: { activeOrderId: null } },
          { session }
        );
      }
      return { order, invoice, reservation };
    });
    const { order, invoice, reservation } = result;

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
      message: `Charge of ${formatCurrency(order.totalAmount, req.hotel?.currency || 'USD')} transferred to Room Folio (${reservation.bookingReference}).`,
      data: {
        order,
        invoice
      }
    });
  } catch (err) {
    next(err);
  }
};
