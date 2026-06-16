package com.inventoryiq.service;

import com.inventoryiq.dto.Dtos.*;
import com.inventoryiq.exception.ApiExceptions.*;
import com.inventoryiq.model.Product;
import com.inventoryiq.repository.ProductRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class ProductService {

    private final ProductRepository products;

    public ProductService(ProductRepository products) { this.products = products; }

    public List<Product> findAll() { return products.findAll(); }

    public Product findById(Long id) {
        return products.findById(id)
            .orElseThrow(() -> new NotFoundException("Product " + id + " not found"));
    }

    @Transactional
    public Product create(ProductRequest req) {
        Product p = new Product();
        p.setName(req.name); p.setSku(req.sku); p.setPrice(req.price); p.setStock(req.stock);
        return products.save(p);
    }

    @Transactional
    public Product adjustStock(Long id, int delta) {
        Product p = findById(id);
        int updated = p.getStock() + delta;
        if (updated < 0) throw new InsufficientStockException("Stock cannot go negative for product " + id);
        p.setStock(updated);
        return products.save(p);
    }
}
