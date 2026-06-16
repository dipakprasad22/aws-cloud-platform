package com.inventoryiq.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.boot.jdbc.DataSourceBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import software.amazon.awssdk.services.secretsmanager.SecretsManagerClient;
import software.amazon.awssdk.services.secretsmanager.model.GetSecretValueRequest;

import javax.sql.DataSource;

/**
 * In production, set DB_SECRET_NAME and DB_HOST/DB_NAME env vars: the datasource
 * fetches the username/password from AWS Secrets Manager at startup — no hardcoded
 * credentials. In local dev (no DB_SECRET_NAME), Spring's normal datasource
 * auto-configuration from application.properties is used instead.
 */
@Configuration
public class DataSourceConfig {

    @Bean
    public DataSource dataSource(Environment env) throws Exception {
        String secretName = env.getProperty("DB_SECRET_NAME");
        if (secretName == null || secretName.isBlank()) {
            // Local dev: fall back to standard Spring datasource properties.
            return DataSourceBuilder.create()
                .url(env.getProperty("spring.datasource.url", "jdbc:postgresql://localhost:5432/inventoryiq"))
                .username(env.getProperty("spring.datasource.username", "postgres"))
                .password(env.getProperty("spring.datasource.password", "postgres"))
                .build();
        }

        // Production: fetch credentials from Secrets Manager.
        try (SecretsManagerClient client = SecretsManagerClient.create()) {
            String json = client.getSecretValue(
                GetSecretValueRequest.builder().secretId(secretName).build()).secretString();
            JsonNode node = new ObjectMapper().readTree(json);
            String user = node.get("username").asText();
            String pass = node.get("password").asText();
            String host = node.has("host") ? node.get("host").asText() : env.getProperty("DB_HOST");
            String db   = node.has("dbname") ? node.get("dbname").asText() : env.getProperty("DB_NAME", "inventoryiq");
            String url  = "jdbc:postgresql://" + host + ":5432/" + db;

            HikariDataSource ds = DataSourceBuilder.create()
                .type(HikariDataSource.class)
                .url(url).username(user).password(pass).build();
            return ds;
        }
    }
}
