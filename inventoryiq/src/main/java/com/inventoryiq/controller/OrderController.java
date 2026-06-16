package com.inventoryiq.controller;

import com.inventoryiq.dto.Dtos.*;
import com.inventoryiq.model.Order;
import com.inventoryiq.service.OrderService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService service;
    public OrderController(OrderService service) { this.service = service; }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Order place(@Valid @RequestBody OrderRequest req) { return service.placeOrder(req); }

    @GetMapping("/{id}")
    public Order one(@PathVariable Long id) { return service.findById(id); }
}
