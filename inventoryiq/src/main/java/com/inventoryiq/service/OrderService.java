package com.inventoryiq.service;

import com.inventoryiq.dto.Dtos.*;
import com.inventoryiq.exception.ApiExceptions.*;
import com.inventoryiq.model.*;
import com.inventoryiq.repository.OrderRepository;
import com.inventoryiq.repository.ProductRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

/**
 * The heart of InventoryIQ. Placing an order is a SINGLE TRANSACTION:
 *  - check every line has enough stock,
 *  - decrement stock for each product,
 *  - compute the total and persist the order.
 * If ANY line fails (e.g. insufficient stock), the whole transaction rolls back —
 * no partial orders, no stock decremented for an order that didn't complete.
 * The Product @Version field provides optimistic locking so two concurrent
 * orders can't both sell the last unit.
 */
@Service
public class OrderService {

    private final OrderRepository orders;
    private final ProductRepository products;

    public OrderService(OrderRepository orders, ProductRepository products) {
        this.orders = orders; this.products = products;
    }

    public Order findById(Long id) {
        return orders.findById(id)
            .orElseThrow(() -> new NotFoundException("Order " + id + " not found"));
    }

    @Transactional
    public Order placeOrder(OrderRequest req) {
        Order order = new Order();
        order.setCustomer(req.customer);
        BigDecimal total = BigDecimal.ZERO;

        for (OrderLine line : req.items) {
            Product p = products.findById(line.productId)
                .orElseThrow(() -> new NotFoundException("Product " + line.productId + " not found"));

            if (p.getStock() < line.quantity) {
                // Throwing here rolls back EVERYTHING done so far in this transaction.
                throw new InsufficientStockException(
                    "Insufficient stock for product " + p.getId() +
                    " (have " + p.getStock() + ", need " + line.quantity + ")");
            }

            // decrement stock (guarded by @Version optimistic lock on save/flush)
            p.setStock(p.getStock() - line.quantity);

            OrderItem item = new OrderItem();
            item.setProductId(p.getId());
            item.setQuantity(line.quantity);
            item.setUnitPrice(p.getPrice());     // capture price at order time
            order.addItem(item);

            total = total.add(p.getPrice().multiply(BigDecimal.valueOf(line.quantity)));
        }

        order.setTotal(total);
        order.setStatus("PLACED");
        return orders.save(order);   // cascade-saves the items; stock changes flush in the same tx
    }
}
