package com.inventoryiq.controller;

import com.inventoryiq.dto.Dtos.*;
import com.inventoryiq.model.Product;
import com.inventoryiq.service.ProductService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/products")
public class ProductController {

    private final ProductService service;
    public ProductController(ProductService service) { this.service = service; }

    @GetMapping
    public List<Product> all() { return service.findAll(); }

    @GetMapping("/{id}")
    public Product one(@PathVariable Long id) { return service.findById(id); }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Product create(@Valid @RequestBody ProductRequest req) { return service.create(req); }

    @PatchMapping("/{id}/stock")
    public Product adjustStock(@PathVariable Long id, @Valid @RequestBody StockAdjustRequest req) {
        return service.adjustStock(id, req.delta);
    }
}
