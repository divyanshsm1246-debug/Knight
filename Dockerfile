# Render has no native Java runtime, so the backend builds and runs in Docker.
# Stage 1: compile the jar with Maven.
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn -B clean package -DskipTests

# Stage 2: a small runtime image. The memory flags keep it inside a 512 MB free instance.
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/target/knight-backend-1.0.0.jar app.jar
ENV JAVA_TOOL_OPTIONS="-Xmx320m -XX:+UseSerialGC -Xss512k"
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
