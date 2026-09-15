# Java 21 is required: this project uses single-file source execution
# (java Knight.java) so there is no Maven/Gradle build step at all.
FROM eclipse-temurin:21-jdk

WORKDIR /app
COPY Knight.java index.html script.js style.css ./

# Render routes traffic to $PORT; Knight.java reads it, defaulting to 3000.
ENV PORT=10000
EXPOSE 10000

CMD ["java", "Knight.java"]
