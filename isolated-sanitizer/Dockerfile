# Use a highly optimized, minimal Node environment base image
FROM node:20-alpine

# Set the operational directory inside the container
WORKDIR /app

# Copy the dependencies map first to optimize layer caching
COPY package.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy the actual processing script code
COPY sanitize.js ./

# Crucial Security Step: Switch from the administrator 'root' user 
# to a generic, restricted 'node' user to trap any system breakouts
USER node

# FIXED: Keep the container alive for up to 30 seconds so server.js can inject commands
CMD ["sleep", "30"]